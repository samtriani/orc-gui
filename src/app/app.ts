import { DatePipe, DecimalPipe, PercentPipe, SlicePipe } from '@angular/common';
import { Component, ElementRef, WritableSignal, computed, effect, inject, signal,
         viewChildren } from '@angular/core';
import { Observable, Subject, of } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, switchMap } from 'rxjs/operators';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Analisis, CitaFallada, Corrida, DiaExpediente, Expediente, FilaCausa, FilaProveedor,
         FilaResponsable, FilaSkuTienda, FilaSubcausa, Orcmm, Tienda,
         Waterfall } from './orcmm';
import { Paginador, PaginadorCtrl } from './paginacion';

/** Comparación laxa para los filtros de texto: sin acentos, sin mayúsculas y
 *  sin espacios de sobra. Se busca un SKU copiado de un Excel, no se hace
 *  una consulta exacta. */
function normalizar(s: string): string {
  return s
    .normalize('NFD')
    // Los acentos quedan como caracteres combinantes aparte tras NFD; el rango
    // va escrito con escapes a propósito, porque literales serían invisibles.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Los cuatro niveles de la jerarquía comercial, de lo general a lo
 *  particular. El orden IMPORTA: es el que define la cascada de los filtros
 *  —elegir una sección acota las categorías, y así hacia abajo—, y los
 *  nombres son los mismos campos que manda el backend en `por_sku_tienda`. */
const NIVELES = ['seccion', 'categoria', 'subcategoria', 'marca'] as const;

/** Posición de la vía y del decil dentro del combo de jerarquía, después
 *  de los cuatro niveles comerciales. Con nombre y no como número suelto:
 *  el backend arma [sección, categoría, subcategoría, marca, vía, decil] y
 *  un índice equivocado no truena, sólo filtra de más o de menos. */
const IDX_VIA = NIVELES.length;
const IDX_DECIL = NIVELES.length + 1;
type Nivel = (typeof NIVELES)[number];

type Paso = 'inicio' | 'trabajando' | 'bloqueado' | 'listo' | 'sin-datos' | 'error';

/** 'archivo': subir Excel+CSV, como siempre. 'tienda': elegir tienda y
 *  periodo y analizar directo contra lo ya cargado en Postgres. */
type Modo = 'archivo' | 'tienda';

/**
 * INTERRUPTOR TEMPORAL — avisos de SIMA en pantalla.
 *
 * Mientras SIMA no entrega los pedidos de tienda, el backend acompaña cada
 * resultado con el aviso de que la prioridad 3 está apagada y el análisis es
 * parcial. Es correcto, pero hoy estorba en pantalla.
 *
 * En true, la pantalla no muestra ni el aviso de análisis parcial ni las
 * líneas de SIMA en las listas de datos faltantes y advertencias.
 *
 * OJO, lo que esto NO cambia:
 *   - El análisis sigue siendo parcial. RC03 'Pedido No Generado' sigue sin
 *     poder aparecer, y sus días se siguen repartiendo entre RC04, RC05 y
 *     RC06. Sólo se dejó de decir en pantalla.
 *   - El Excel que se descarga SÍ trae el aviso en rojo, en tres hojas. Se
 *     apaga desde el backend con EVALUAR_PEDIDO_TIENDA = True, cuando lleguen
 *     los datos.
 *
 * Para volver a mostrarlo: poner false.
 */
const OCULTAR_AVISOS_SIMA = true;

/**
 * INTERRUPTOR — los dos paneles del boceto que todavía no tienen datos:
 * "Tendencia de OSA vs. meta" y "Evolución del mix de causas raíz".
 *
 * Los dos necesitan seis meses cerrados y hoy hay 43 días cargados
 * (2026-02-16 a 2026-03-30). Se maquetaron con su aviso de qué falta, pero
 * por ahora estorban en pantalla.
 *
 * En false no se dibujan. El maquetado se queda en el HTML: cuando lleguen
 * los periodos anteriores, esto vuelve a true y ya está — no hay que
 * rehacerlo. Ver `diasDeHistoria()` y `rangoHistoria()`, que son los que
 * arman el aviso.
 */
/**
 * INTERRUPTOR — la tabla "¿Qué dato bloqueó la clasificación?".
 *
 * Apagada a petición. Lista los campos que impidieron dictaminar un día y
 * cuánta venta perdida arrastra cada uno; sirve para priorizar qué fuente
 * integrar primero, no para leer el resultado del negocio.
 *
 * Se apaga con la constante y NO se borra el maquetado: sigue compilando,
 * así que volver a prenderla es cambiar esto a true. El dato lo sigue
 * mandando el backend en `cobertura.bloqueos` — es el que usamos para
 * diagnosticar, por ejemplo, los 24,130 días de San Miguel sin inventario.
 */
/**
 * INTERRUPTOR — el aviso ámbar de "fuera de alcance".
 *
 * Apagado a petición: explica que BOPS entrega todas las divisiones de la
 * tienda mientras el catálogo sólo cubre Abarrotes, y que por eso hay días
 * que al modelo no le tocaba explicar. Ya es sabido por quien lee el
 * reporte.
 *
 * NO cambia ningún número: esos días nunca entraron al Pareto ni a la
 * cobertura del alcance —los filtra dentro_del_alcance()— y siguen saliendo
 * como RC00 en la clasificación diaria. Lo único que se apaga es el letrero.
 *
 * El contraste sigue disponible: la tarjeta de OSA de portada dice "Sobre
 * los SKU del catálogo de la tienda", y `osa_general` viaja en la respuesta.
 */
const MOSTRAR_AVISO_FUERA_DE_ALCANCE = false;

const MOSTRAR_BLOQUEOS = false;

const MOSTRAR_PANELES_SIN_DATOS = false;

/** Colores de la matriz, los mismos del Excel de resultados. Van en las
 *  fichas de las tablas, que llevan el texto de la causa al lado: ahí el
 *  color acompaña y no necesita cargar la identidad. */

/**
 * El color de cada causa raíz. ÚNICA paleta: la usan las barras de "SKU que
 * más costaron", las fichas de las tablas y la tira del expediente.
 *
 * Antes convivía con una segunda, heredada de los pastel del Excel, y esa
 * repetía colores: RC03, RC05 y RC06 eran el MISMO rosa y RC02 con RC04 el
 * mismo amarillo, así que en "SKU que más costaron" tres causas distintas se
 * veían idénticas. RC07 ni existía en ella y caía al gris de "sin
 * clasificar" — siendo la segunda causa de Coyoacán con 5,312 días.
 *
 * Ahí los pasteles del Excel no sirven: son cuadros de 8 px sobre blanco y
 * `#F2F2F2` o `#DDEBF7` simplemente no se ven — fue lo primero que se notó al
 * usarlo. Estos pasan la banda de luminosidad, el piso de croma y el 3:1 de
 * contraste contra el blanco de la tarjeta.
 *
 * El orden NO es arbitrario: está asignado por frecuencia real, para que las
 * dos causas que de verdad coinciden en un mismo SKU queden lo más separadas
 * posible. RC01 (94.1% de los días) contra RC06 (5.3%) miden ΔE 34.8 en
 * visión normal y 22.8 en protanopía — o sea el 99.4% de los días se lee sin
 * ambigüedad.
 *
 * RC99 va en rojo oscuro a propósito. No es una causa más: es "no supimos
 * clasificarlo", una alarma. Antes era gris y se confundía con los días sin
 * faltante, que también eran grises. El rojo es `#a10c22` y no el `#c8102e`
 * de siempre porque ése queda a ΔE 12.7 del naranja de RC01 —bajo el piso de
 * 15— mientras que éste mide 20.2.
 *
 * Lo que NO pasa el conjunto completo es la separación con todos los pares:
 * los pares raros (RC03 contra RC05, RC04 contra RC05) quedan cortos, y con
 * el naranja de marca fijo ninguna combinación de siete lo resuelve. Son
 * causas de 0.1-0.3% que en la práctica no coinciden, pero por eso el
 * expediente lleva leyenda obligatoria con las causas que aparecen en ese
 * SKU, más el tooltip por día: la identidad está escrita y el color sólo
 * refuerza. Si se quita la leyenda, esto queda mal.
 */
const COLOR_CAUSA: Record<string, string> = {
  RC01: '#f0501e', // Ejecución en Tienda        — 94.1% de los días
  RC06: '#0079c1', // Incumplimiento Proveedor   —  5.3%
  RC05: '#4e8b2c', // Pedido a proveedor no generado —  0.3%
  // Magenta: es el hueco más ancho que quedaba en la rueda —los otros ocho
  // ocupan naranja, ámbar, verde, teal, azul, morado, rojo y malva—. Y RC07
  // pesa mucho más que su hermano RC05, así que necesita color propio y no
  // un tono vecino del verde.
  RC07: '#b5307f', // Pedido a proveedor tardío
  // "Pedidos" — la fusión de RC03, RC05 y RC07 (ver FUSIONAR_PEDIDOS en el
  // motor). Se queda con el magenta de RC07 a propósito: de los 8,216 días de
  // la bolsa, 5,312 ya eran RC07, así que la tira diaria se ve casi igual
  // antes y después de fusionar y nadie tiene que reaprender el color. Los
  // tres códigos originales siguen en el mapa para que apagar el interruptor
  // no deje ninguna causa sin color.
  RC08: '#b5307f', // Pedidos
  RC02: '#7b2d8e', // Transporte / Tránsito      —  0.1%
  RC04: '#00a199', // CEDIS No Surtió            —  0.1%
  RC03: '#b07500', // Pedido de Tienda No Gen.
  RC99: '#a10c22', // Sin clasificar — rojo: es una alarma, no una causa
  RC00: '#8f86a8', // Fuera de alcance — malva apagado: no es alarma, es "no tocaba"
};

@Component({
  selector: 'app-root',
  imports: [DatePipe, DecimalPipe, PercentPipe, SlicePipe, PaginadorCtrl],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly api = inject(Orcmm);

  constructor() {
    // El histórico y los nombres de tienda se piden al entrar: la pantalla
    // inicial es la lista de corridas, y sin los nombres los renglones sólo
    // dirían "Tienda 287".
    this.cargarCorridas();
    this.asegurarNombresDeTienda();

    // La evolución diaria es de UN SKU en UNA tienda. Si cambia cualquiera de
    // los dos, la gráfica abierta deja de corresponder al filtro: el
    // encabezado decía un código y el filtro otro, y así se lee como si fuera
    // del que acabas de buscar. Se cierra y que la vuelvan a pedir.
    //
    // No se recarga sola a propósito: el filtro de SKU admite varias fichas y
    // no habría forma de saber cuál de ellas graficar.
    effect(() => {
      this.filtroSku();
      this.filtroTienda();
      this.cerrarExpediente();
    });

    // El autocompletar de SKU pregunta al catálogo mientras se escribe. Con
    // retardo y descartando la anterior: son teclazos, no clics, y una
    // respuesta vieja llegando tarde pisaría a la nueva.
    this.tecleoSku
      .pipe(
        debounceTime(250),
        distinctUntilChanged(),
        switchMap((q) => {
          const t = this.tiendaDelAnalisis();
          if (q.trim().length < 2) {
            this.avisoBusqueda.set(null);
            return of([]);
          }
          if (!t) {
            this.avisoBusqueda.set('No se sabe en qué tienda buscar.');
            return of([]);
          }
          return this.api.buscarSkus(t, q.trim()).pipe(
            // El error NO se traga: tragárselo hacía que "no trae nada" y "el
            // endpoint no existe" se vieran exactamente igual, y no había
            // forma de distinguirlos desde la pantalla.
            catchError((e) => {
              this.avisoBusqueda.set(
                e?.status === 404
                  ? 'La API no tiene el buscador de catálogo todavía.'
                  : `No se pudo buscar en el catálogo (${e?.status ?? 'sin respuesta'}).`,
              );
              return of([]);
            }),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe((skus) => {
        if (skus.length) this.avisoBusqueda.set(null);
        this.sugerenciasCatalogo.set(skus);
        // Y se recuerdan. Las sugerencias se reemplazan en cada búsqueda,
        // pero la descripción de un SKU ya visto sigue haciendo falta
        // después: al confirmar la ficha, la caja se vacía y la búsqueda
        // siguiente devuelve otra cosa — y el nombre desaparecía justo
        // cuando el usuario ya lo tenía seleccionado.
        if (skus.length) {
          this.nombresDelCatalogo.update((m) => {
            const n = new Map(m);
            for (const s of skus) if (s.descripcion) n.set(s.sku, s.descripcion);
            return n;
          });
        }
      });
  }

  private readonly tecleoSku = new Subject<string>();
  /** Lo que devolvió el catálogo para lo último que se escribió. Se suma a
   *  las opciones que salen del resultado. */
  private readonly sugerenciasCatalogo =
    signal<{ sku: string; descripcion: string | null }[]>([]);
  /** Código -> nombre, acumulado de todo lo que el catálogo ha respondido. */
  private readonly nombresDelCatalogo = signal(new Map<string, string>());
  /** Por qué el buscador no trajo nada, cuando la razón no es que no haya. */
  readonly avisoBusqueda = signal<string | null>(null);

  /**
   * Las tres series booleanas de la gráfica diaria, en el orden de la cadena:
   * primero pide la tienda, luego viaja, luego lo repone el proveedor.
   *
   * Van en un arreglo y no escritas a mano en la plantilla para que la
   * etiqueta, el tooltip y el dato salgan del MISMO lugar: antes el HTML
   * decía "CD" y el título decía "Tránsito", y sólo con leer los dos se
   * notaba que no hablaban de lo mismo.
   */
  readonly marcasExpediente = [
    { clave: 'PT', etiqueta: 'Pedido de tienda',
      ayuda: 'Pedido de la tienda a CEDIS abierto ese día',
      activo: (d: DiaExpediente) => !!d.pedido_tienda_abierto },
    // Se llamaba CD, que se leía como "CEDIS" y no como lo que mide.
    { clave: 'TR', etiqueta: 'Tránsito',
      ayuda: 'Envío generado o mercancía en tránsito de CEDIS a tienda',
      activo: (d: DiaExpediente) => !!(d.transito_vigente || d.envio_generado) },
    { clave: 'PV', etiqueta: 'Pedido a proveedor',
      ayuda: 'Orden a proveedor vigente ese día',
      activo: (d: DiaExpediente) => !!d.orden_proveedor_vigente },
  ];

  /** Ver MOSTRAR_AVISO_FUERA_DE_ALCANCE. */
  readonly mostrarAvisoFueraDeAlcance = MOSTRAR_AVISO_FUERA_DE_ALCANCE;

  /** Ver MOSTRAR_BLOQUEOS. */
  readonly mostrarBloqueos = MOSTRAR_BLOQUEOS;

  readonly paso = signal<Paso>('inicio');
  readonly archivos = signal<File[]>([]);
  readonly resultado = signal<Analisis | null>(null);
  readonly error = signal<string | null>(null);
  readonly arrastrando = signal(false);
  readonly verDetalle = signal(false);
  /** Cuánto lleva EN SU FASE actual, según el backend. */
  readonly segundos = signal(0);
  readonly fase = signal<'en_cola' | 'corriendo'>('corriendo');
  /** En qué fase de la corrida va, según el backend. */
  readonly etapa = signal<string | null>(null);
  readonly delante = signal(0);
  /** El id en vuelo, para poder cancelarlo. */
  readonly idEnVuelo = signal<string | null>(null);
  readonly cancelando = signal(false);
  /** Cuando el backend rechaza por 409, el análisis que ya estaba corriendo. */
  readonly yaHayUno = signal<{ id: string; archivo: string } | null>(null);

  // -- analizar desde la base de datos (tienda + periodo) ------------------

  readonly modo = signal<Modo>('archivo');
  readonly tiendasDisponibles = signal<Tienda[]>([]);
  readonly cargandoTiendas = signal(false);

  /** El histórico de corridas. Una corrida completa tarda ~5.7 minutos, así
   *  que volver a ver una ya hecha tiene que ser instantáneo: se lee de la
   *  tabla `runs` en vez de recalcularla. */
  readonly corridas = signal<Corrida[]>([]);
  readonly cargandoCorridas = signal(false);
  readonly abriendoCorrida = signal<string | null>(null);
  /** Obligatoria y de selección única: el análisis siempre corre sobre
   *  exactamente esta tienda, nunca "todas" ni varias a la vez. */
  readonly tiendaSeleccionada = signal('');
  readonly fechaDesde = signal('');
  readonly fechaHasta = signal('');

  readonly tiendaActiva = computed(
    () => this.tiendasDisponibles().find((t) => t.tienda === this.tiendaSeleccionada()) ?? null,
  );

  readonly etiquetaTrabajo = computed(() =>
    this.modo() === 'archivo'
      ? this.nombrePaquete()
      : `Tienda ${this.tiendaSeleccionada()} · ${this.fechaDesde()} a ${this.fechaHasta()}`,
  );

  readonly nombrePaquete = computed(() => {
    const a = this.archivos();
    if (!a.length) return '';
    const layout = a.find((f) => f.name.toLowerCase().endsWith('.xlsx')) ?? a[0];
    const resto = a.length - 1;
    return resto > 0 ? `${layout.name} + ${resto} archivo${resto > 1 ? 's' : ''}` : layout.name;
  });

  /** El archivo trae errores de layout pero la corrección automática los quita. */
  readonly ofreceCorreccion = computed(() => {
    const r = this.resultado();
    return r?.estado === 'bloqueado' && r.corregible === true;
  });

  readonly urlDescarga = computed(() => {
    const r = this.resultado();
    return r?.estado === 'ok' ? this.api.urlDescarga(r.id) : null;
  });

  /** El Excel se escribe DESPUÉS de servir el resultado, así que hay unos
   *  minutos en que la pantalla ya está y el archivo todavía no. Un `<a
   *  href>` a secas mostraba un 404 crudo en esa ventana; aquí se pide, y si
   *  el backend responde 409 se dice que va en camino. */
  readonly bajando = signal(false);
  readonly avisoDescarga = signal<string | null>(null);

  descargarExcel(e: Event): void {
    e.preventDefault();
    const url = this.urlDescarga();
    if (!url || this.bajando()) return;
    this.bajando.set(true);
    this.avisoDescarga.set(null);
    this.api.descargar(url).subscribe({
      next: (blob) => {
        this.bajando.set(false);
        const enlace = document.createElement('a');
        enlace.href = URL.createObjectURL(blob);
        enlace.download = this.resultado()?.nombre_salida || 'resultado.xlsx';
        enlace.click();
        // Sin esto el blob se queda en memoria toda la sesión, y son 16 MB.
        setTimeout(() => URL.revokeObjectURL(enlace.href), 30_000);
      },
      error: (err) => {
        this.bajando.set(false);
        this.avisoDescarga.set(
          err?.status === 409
            ? 'El Excel todavía se está generando. Son unos minutos: las cifras de ' +
              'la pantalla ya son las definitivas, el archivo va detrás.'
            : 'No se pudo descargar el Excel.',
        );
      },
    });
  }

  // -- avisos, filtrados por el interruptor de SIMA ------------------------
  //
  // El backend manda todo; aquí sólo se decide qué se enseña. Así el día que
  // se apague el interruptor no hay que tocar el backend ni volver a correr
  // nada: los mensajes ya venían en la respuesta.

  readonly avisoParcial = computed(() =>
    OCULTAR_AVISOS_SIMA ? null : (this.resultado()?.aviso_parcial ?? null),
  );

  readonly faltanDatos = computed(() =>
    this.sinSima(this.resultado()?.validacion?.faltan_datos),
  );

  readonly advertencias = computed(() => this.sinSima(this.resultado()?.advertencias));

  /** Quita las líneas que hablan de SIMA, dejando el resto intacto.
   *  Se filtra por el nombre de la hoja, que es como el backend las nombra. */
  private sinSima(lineas: string[] | undefined): string[] {
    const todas = lineas ?? [];
    if (!OCULTAR_AVISOS_SIMA) return todas;
    return todas.filter((l) => !l.includes('SIMA'));
  }

  // -- selección de archivo ------------------------------------------------

  elegir(evento: Event): void {
    const input = evento.target as HTMLInputElement;
    this.tomar(input.files);
  }

  soltar(evento: DragEvent): void {
    evento.preventDefault();
    this.arrastrando.set(false);
    this.tomar(evento.dataTransfer?.files ?? null);
  }

  sobrevolar(evento: DragEvent, dentro: boolean): void {
    evento.preventDefault();
    this.arrastrando.set(dentro);
  }

  /**
   * La captura son varios archivos desde el layout V5: el .xlsx más los CSV
   * de las hojas que ya no caben en una hoja de Excel, o un .zip con todo.
   *
   * Se revisa aquí lo mismo que revisa el backend, para no gastar una subida
   * de cientos de MB en un paquete que va a rebotar.
   */
  private tomar(lista: FileList | null): void {
    const archivos = Array.from(lista ?? []);
    if (!archivos.length) return;

    const nombre = (f: File) => f.name.toLowerCase();
    const malos = archivos.filter((f) => !/\.(xlsx|csv|zip)$/.test(nombre(f)));
    if (malos.length) {
      this.fallar(
        `Sólo se aceptan .xlsx (el layout), .csv (las fuentes grandes) o un .zip con ` +
          `todo dentro. Sobra: ${malos.map((f) => f.name).join(', ')}.`,
      );
      return;
    }

    const layouts = archivos.filter((f) => nombre(f).endsWith('.xlsx'));
    const zips = archivos.filter((f) => nombre(f).endsWith('.zip'));

    if (layouts.length > 1) {
      this.fallar(
        `Llegaron ${layouts.length} archivos .xlsx y sólo puede haber un layout: ` +
          `${layouts.map((f) => f.name).join(', ')}.`,
      );
      return;
    }
    if (!layouts.length && !zips.length) {
      this.fallar('Falta el .xlsx del layout de captura (o el .zip que lo contenga).');
      return;
    }

    this.archivos.set(archivos);
    this.error.set(null);
    this.analizar(false);
  }

  private fallar(mensaje: string): void {
    this.error.set(mensaje);
    this.paso.set('error');
  }

  // -- análisis ------------------------------------------------------------

  /**
   * `forzar` deja correr el análisis aunque queden errores que la corrección
   * automática no puede arreglar. Sirve cuando lo roto es una hoja de la que
   * depende sólo una parte del reporte: una extracción de citas incompleta
   * afecta al scorecard del proveedor, no al Pareto.
   */
  analizar(corregir: boolean, forzar = false): void {
    const archivos = this.archivos();
    if (!archivos.length) return;

    this.enganchar(
      this.api.analizar(archivos, corregir, forzar),
      'No se pudo contactar al backend. Revisar que esté corriendo en el puerto 8000.',
    );
  }

  /**
   * Todo lo que hay que hacer con un análisis en vuelo, para las dos rutas
   * (archivo y tienda), que hacían exactamente lo mismo por duplicado.
   *
   * El 409 no es un error: es el backend diciendo "ya hay uno corriendo, el
   * servidor lleva uno a la vez". Encolar otro no lo apura, así que en vez de
   * enseñar un error se ofrece seguir el que ya va.
   */
  private enganchar(flujo: Observable<Analisis>, mensajeError: string): void {
    this.paso.set('trabajando');
    this.error.set(null);
    this.yaHayUno.set(null);
    this.segundos.set(0);
    this.fase.set('corriendo');
    this.etapa.set(null);
    this.delante.set(0);
    this.cancelando.set(false);

    flujo.subscribe({
      next: (r) => {
        this.idEnVuelo.set(r.id);
        if (r.estado === 'en_proceso') {
          this.segundos.set(r.segundos ?? 0);
          this.fase.set(r.fase ?? 'corriendo');
          this.etapa.set(r.etapa ?? null);
          this.delante.set(r.delante ?? 0);
          return;
        }
        this.idEnVuelo.set(null);
        if (r.estado === 'cancelado') {
          this.reiniciar();
          return;
        }
        this.resultado.set(r);
        this.paso.set(
          r.estado === 'ok' ? 'listo' : r.estado === 'sin_datos' ? 'sin-datos' : 'bloqueado',
        );
        if (r.estado === 'ok') this.asegurarNombresDeTienda();
      },
      error: (e) => {
        this.idEnVuelo.set(null);
        const d = e?.error?.detail;
        if (e?.status === 409 && d?.id_activo) {
          this.yaHayUno.set({ id: d.id_activo, archivo: d.archivo });
          this.paso.set('inicio');
          return;
        }
        this.error.set(typeof d === 'string' ? d : mensajeError);
        this.paso.set('error');
      },
    });
  }

  /** Engancha con el análisis que ya venía corriendo, sin encolar otro. */
  seguirElQueVa(): void {
    const activo = this.yaHayUno();
    if (!activo) return;
    this.enganchar(this.api.seguirExistente(activo.id), 'Se perdió el análisis en curso.');
  }

  cancelarEnVuelo(): void {
    const id = this.idEnVuelo();
    if (!id || this.cancelando()) return;
    this.cancelando.set(true);
    this.api.cancelar(id).subscribe({
      next: () => this.reiniciar(),
      error: () => {
        this.cancelando.set(false);
        this.error.set('No se pudo cancelar el análisis.');
      },
    });
  }

  reiniciar(): void {
    // Al volver al inicio se refresca el histórico: puede traer la corrida
    // que se acaba de hacer, o una que corrió alguien más mientras tanto.
    this.cargarCorridas();
    this.archivos.set([]);
    this.resultado.set(null);
    this.error.set(null);
    this.verDetalle.set(false);
    this.segundos.set(0);
    this.tiendaSeleccionada.set('');
    this.fechaDesde.set('');
    this.fechaHasta.set('');
    this.limpiarFiltros();
    this.paso.set('inicio');
    // 'modo' no se reinicia a propósito: si el usuario ya estaba en "elegir
    // tienda y periodo", tiene más sentido que se quede ahí que forzarlo de
    // vuelta a "subir archivo".
  }

  // -- histórico de corridas ------------------------------------------------

  /** Se pide al entrar y después de cada análisis. En silencio: si el
   *  histórico no responde, la pantalla sigue sirviendo para correr uno
   *  nuevo — no vale la pena bloquearla por un listado. */
  private cargarCorridas(): void {
    this.cargandoCorridas.set(true);
    this.api.listarCorridas().subscribe({
      next: (cs) => {
        this.corridas.set(cs);
        this.cargandoCorridas.set(false);
      },
      error: () => this.cargandoCorridas.set(false),
    });
  }

  /** Abre una corrida guardada. No recalcula nada: trae el mismo resumen que
   *  produjo el análisis original y lo pinta. */
  abrirCorrida(c: Corrida): void {
    this.abriendoCorrida.set(c.id);
    this.error.set(null);
    this.api.leerCorrida(c.id).subscribe({
      next: (a) => {
        this.abriendoCorrida.set(null);
        this.limpiarFiltros();
        // El periodo de la corrida, no el del formulario: el expediente lo
        // necesita para pedir el detalle diario, y al abrir del histórico
        // esas señales están vacías. Sin esto el botón "Ver evolución
        // diaria" no hacía absolutamente nada.
        this.tiendaSeleccionada.set(c.tienda);
        this.fechaDesde.set(c.desde);
        this.fechaHasta.set(c.hasta);
        this.resultado.set(a);
        this.paso.set('listo');
        this.asegurarNombresDeTienda();
        window.scrollTo({ top: 0 });
      },
      error: () => {
        this.abriendoCorrida.set(null);
        this.error.set('No se pudo abrir esa corrida. Puede que la hayan borrado.');
      },
    });
  }

  /** El Excel de una corrida guardada. Se genera al pedirlo desde
   *  `run_dias` —no vuelve a leer fuentes ni a clasificar— pero aun así son
   *  un par de minutos, así que el botón se queda en "Generando…" y no se
   *  puede picar dos veces. */
  readonly generandoExcel = signal<string | null>(null);

  bajarExcelCorrida(c: Corrida, e: Event): void {
    e.stopPropagation();
    if (this.generandoExcel()) return;
    this.generandoExcel.set(c.id);
    this.error.set(null);
    this.api.descargar(this.api.urlExcelCorrida(c.id)).subscribe({
      next: (blob) => {
        this.generandoExcel.set(null);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `Resultado RCA - ${c.tienda} ${c.desde} a ${c.hasta}.xlsx`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
      },
      error: (err) => {
        this.generandoExcel.set(null);
        this.error.set(
          err?.status === 404
            ? 'Esa corrida no tiene detalle guardado: sólo se puede regenerar el Excel ' +
              'de las corridas hechas después de que se empezó a guardarlo.'
            : 'No se pudo generar el Excel de esa corrida.',
        );
      },
    });
  }

  descartarCorrida(c: Corrida, e: Event): void {
    e.stopPropagation();
    this.api.borrarCorrida(c.id).subscribe({
      next: () => this.corridas.update((cs) => cs.filter((x) => x.id !== c.id)),
      error: () => this.error.set('No se pudo borrar esa corrida.'),
    });
  }

  etiquetaCorrida(c: Corrida): string {
    const t = this.nombrePorTienda().get(c.tienda);
    return t ? `${c.tienda} · ${t}` : `Tienda ${c.tienda}`;
  }

  // -- analizar desde la base de datos (tienda + periodo) -------------------

  elegirModo(m: Modo): void {
    this.modo.set(m);
    this.error.set(null);
    if (m === 'tienda' && !this.tiendasDisponibles().length) {
      this.cargandoTiendas.set(true);
      this.api.listarTiendas().subscribe({
        next: (ts) => {
          this.tiendasDisponibles.set(ts);
          this.cargandoTiendas.set(false);
        },
        error: () => {
          this.error.set('No se pudo cargar la lista de tiendas.');
          this.cargandoTiendas.set(false);
        },
      });
    }
  }

  /** Los nombres de tienda para los combos del resultado. Se pide en
   *  silencio: es un adorno de la pantalla, no algo por lo que valga la pena
   *  enseñar un error — si falla, los combos se quedan con la clave. */
  private asegurarNombresDeTienda(): void {
    if (this.tiendasDisponibles().length) return;
    this.api.listarTiendas().subscribe({
      next: (ts) => this.tiendasDisponibles.set(ts),
      error: () => {},
    });
  }

  ponTiendaSeleccionada(evento: Event): void {
    const tienda = (evento.target as HTMLSelectElement).value;
    this.tiendaSeleccionada.set(tienda);
    // Precarga el rango disponible de esa tienda — sigue siendo editable,
    // pero de entrada ya queda un periodo válido con dos clics menos.
    const t = this.tiendasDisponibles().find((x) => x.tienda === tienda);
    this.fechaDesde.set(t?.fecha_min ?? '');
    this.fechaHasta.set(t?.fecha_max ?? '');
  }

  ponFechaDesde(evento: Event): void {
    this.fechaDesde.set((evento.target as HTMLInputElement).value);
  }

  ponFechaHasta(evento: Event): void {
    this.fechaHasta.set((evento.target as HTMLInputElement).value);
  }

  analizarTienda(): void {
    const tienda = this.tiendaSeleccionada();
    const desde = this.fechaDesde();
    const hasta = this.fechaHasta();
    if (!tienda || !desde || !hasta) return;

    this.enganchar(
      this.api.analizarPorTienda(tienda, desde, hasta),
      'No se pudo analizar desde la base de datos.',
    );
  }

  // -- portada ejecutiva ---------------------------------------------------

  /** Hay días de BOPS que el catálogo de la tienda no reconoce. Cuando pasa,
   *  la portada tiene que decir sobre qué universo está hablando. */
  readonly hayFueraDeAlcance = computed(
    () => (this.resultado()?.cobertura?.casos_fuera_de_alcance ?? 0) > 0,
  );

  /** SKU distintos con faltante dentro del alcance. Sale del detalle por
   *  SKU-tienda, que ya viene filtrado al alcance desde el backend. */
  readonly skusConGap = computed(
    () => new Set((this.resultado()?.por_sku_tienda ?? []).map((s) => s.sku)).size,
  );

  /** El escalón más grande del waterfall, para escalar las barras. Sin esto,
   *  con 12.28 pp contra 0.01 pp las chicas no se verían. */
  private readonly escalonMayor = computed(() =>
    Math.max(...(this.resultado()?.waterfall?.escalones ?? []).map((e) => e.puntos_osa), 0.01),
  );

  anchoEscalon(puntos: number): string {
    return `${Math.max((puntos / this.escalonMayor()) * 100, 1.5)}%`;
  }

  /** Top de SKU por impacto para la portada. El listado completo vive en el
   *  detalle; aquí sólo caben los que mueven la aguja. Sale de la lista YA
   *  filtrada (`skusFiltrados`, más abajo) — a diferencia del waterfall y el
   *  Pareto por causa/responsable, aquí sí se puede sin arriesgar el número:
   *  cada renglón ya trae su propia venta_perdida, no hay nada que
   *  recalcular mal. El orden (mayor venta perdida primero) lo pone el
   *  backend y el filtro no lo revuelve. */
  // 10, igual que el bottom y que las tablas paginadas: las dos listas se
  // leen en paralelo y con tamaños distintos parecía que una escondía algo.
  readonly topSkus = computed(() => this.skusFiltrados().slice(0, 10));

  private readonly ventaMayor = computed(() =>
    Math.max(...this.topSkus().map((s) => s.venta_perdida), 1),
  );

  anchoSku(venta: number): string {
    return `${Math.max((venta / this.ventaMayor()) * 100, 2)}%`;
  }

  /** Los 10 de MENOR venta perdida, entre los que sí tuvieron gap.
   *
   *  La lista viene ordenada de mayor a menor, así que la cola son los de
   *  menor impacto; se invierte para que se lea de menor a mayor. No incluye
   *  los SKU que nunca faltaron: ésos no están en `por_sku_tienda` porque no
   *  tienen nada que explicar, y meterlos sería una lista de ceros.
   *
   *  Si hay 10 o menos en total, top y bottom serían la misma lista, así que
   *  no se muestra: repetir la misma tabla dos veces sólo confunde. */
  readonly bottomSkus = computed(() => {
    const todos = this.skusFiltrados();
    if (todos.length <= 10) return [];
    return todos.slice(-10).reverse();
  });

  /** Escala propia del bottom: contra el máximo del top, estas barras darían
   *  todas cero ancho — el SKU más caro cuesta órdenes de magnitud más. */
  private readonly ventaMayorBaja = computed(() =>
    Math.max(...this.bottomSkus().map((s) => s.venta_perdida), 1),
  );

  anchoSkuBajo(venta: number): string {
    return `${Math.max((venta / this.ventaMayorBaja()) * 100, 2)}%`;
  }

  /** Columnas de la tabla de detalle — la tienda y el botón son opcionales. */
  readonly columnasDetalle = computed(
    () => 7 + (this.tiendasAnalizadas().length > 1 ? 1 : 0) + (this.modo() === 'tienda' ? 1 : 0),
  );

  // ========================================================================
  // FILTROS
  // ========================================================================
  //
  // Todo se filtra en el navegador, sobre lo que ya trajo la respuesta. No se
  // vuelve a llamar al backend: las listas más grandes son cientos de
  // renglones, no miles, y el análisis tarda minutos — refiltrar contra el
  // servidor sería absurdo.

  /** SKU y proveedor aceptan varios a la vez — "cualquiera de estos". Cada
   *  uno lleva su propio texto en captura (`entradaSku`/`entradaProveedor`)
   *  aparte del arreglo ya confirmado: escribir no filtra todavía, hay que
   *  darle Enter (o elegir la sugerencia del <datalist>) para que se
   *  agregue como ficha. */
  readonly filtroSku = signal<string[]>([]);
  readonly entradaSku = signal('');
  readonly filtroTienda = signal('');
  readonly filtroCausa = signal('');
  /** Vía de resurtido. Es la que USÓ el modelo, no la del catálogo: desde que
   *  los pedidos DSD se leen de COMPRAS, hay SKU marcados "Vía 2" que se
   *  clasifican por la rama directa. Viene en el catálogo de combos. */
  readonly filtroVia = signal<string[]>([]);

  /** Decil de venta, de CATALOGO. Filtra igual que la vía: entra al mismo
   *  combo, así que recompone el denominador del OSA sin código extra.
   *
   *  Multiselección con semántica OR: la pregunta del negocio no es "¿cómo va
   *  el decil 2?" sino "¿cómo va el top de rotación?", y eso son los deciles
   *  1 a 3 SUMADOS. De uno en uno no se pueden agregar. */
  readonly filtroDecil = signal<string[]>([]);
  readonly filtroResponsable = signal('');
  readonly filtroProveedor = signal<string[]>([]);
  readonly entradaProveedor = signal('');

  /** Jerarquía comercial. Los cuatro niveles funcionan igual que el de SKU
   *  —fichas y autocompletar— así que se guardan en un mapa por nivel y no
   *  como cuatro señales sueltas: la plantilla los pinta con un solo `@for`
   *  y los handlers son uno solo con el nivel de parámetro. */
  readonly filtroNivel: Record<Nivel, WritableSignal<string[]>> = {
    seccion: signal<string[]>([]),
    categoria: signal<string[]>([]),
    subcategoria: signal<string[]>([]),
    marca: signal<string[]>([]),
  };
  readonly entradaNivel: Record<Nivel, WritableSignal<string>> = {
    seccion: signal(''),
    categoria: signal(''),
    subcategoria: signal(''),
    marca: signal(''),
  };

  readonly niveles: { clave: Nivel; etiqueta: string }[] = [
    { clave: 'seccion', etiqueta: 'Sección' },
    { clave: 'categoria', etiqueta: 'Categoría' },
    { clave: 'subcategoria', etiqueta: 'Subcategoría' },
    { clave: 'marca', etiqueta: 'Marca' },
  ];

  // No hay filtro de Formato a propósito: el análisis corre sobre UNA tienda
  // (ver /api/analizar-tienda), así que el formato es el mismo en todos los
  // renglones y el desplegable saldría siempre con una sola opción. El
  // formato de la tienda se lee arriba, en el encabezado.

  /**
   * Las cajas de texto de los filtros con fichas (SKU, proveedor y los
   * cuatro niveles), para poder vaciarlas a mano al limpiar.
   *
   * Hace falta porque `[value]` no basta. Cuando el navegador confirma una
   * sugerencia del `<datalist>` escribe el texto en el input por su cuenta;
   * nuestro handler mete la ficha y deja la señal en vacío, así que Angular
   * anota "este binding vale ''" mientras la caja se quedó con el texto. Al
   * darle Limpiar, la señal ya valía '' —no cambió nada— y el binding no
   * escribe: el texto se queda pegado aunque el filtro sí se haya ido.
   */
  private readonly cajasFiltro = viewChildren<ElementRef<HTMLInputElement>>('cajaFiltro');

  readonly hayFiltro = computed(
    () =>
      !!(
        this.filtroSku().length ||
        this.filtroTienda() ||
        this.filtroCausa() ||
        this.filtroResponsable() ||
        this.filtroProveedor().length ||
        this.filtroVia().length ||
        this.filtroDecil().length ||
        NIVELES.some((n) => this.filtroNivel[n]().length)
      ),
  );

  // -- opciones de autocompletar (<datalist>), sacadas de los propios datos
  //
  // El SKU se busca por código O por nombre: la etiqueta de la sugerencia
  // trae los dos ("código — nombre"), así que el filtrado nativo del
  // navegador encuentra el renglón aunque se escriba parte del nombre. Al
  // elegir la sugerencia o darle Enter, agregarSku() se queda sólo con el
  // código — la ficha del filtro no necesita el nombre completo.

  readonly opcionesSku = computed(() => {
    // El SKU es el último eslabón de la cascada: si ya elegiste CERVEZA en
    // Sección, aquí sólo se sugieren cervezas. Al revés no —elegir un SKU no
    // acota las secciones— porque el SKU es lo más particular que hay: el
    // resto de los niveles quedarían con un solo valor cada uno.
    const etiquetar = (sku: string, descripcion: string | null) => ({
      sku,
      descripcion,
      etiqueta: descripcion ? `${sku} — ${descripcion}` : sku,
    });

    // 1. Lo que el catálogo acaba de responder, EN EL ORDEN EN QUE VINO.
    //
    //    Viene rankeado por relevancia desde el backend —cuántas palabras
    //    empatan en el nombre, y a igualdad el nombre más corto—. Antes esto
    //    se mezclaba con todo lo demás y se reordenaba por código, lo que
    //    tiraba ese trabajo: buscando "bonafont 750 ml" salía primero un
    //    "AGUA SABOR FRESA LEVITE BONAFONT 600 ML" nada más porque su código
    //    empieza con 75030 y el del bueno con 75810.
    //
    //    Los SKU sanos entran por aquí y sólo por aquí: volcarlos todos desde
    //    el universo llenaba el desplegable de miles de códigos sin nombre.
    const opciones = this.sugerenciasCatalogo().map((s) => etiquetar(s.sku, s.descripcion));
    const vistos = new Set(opciones.map((o) => o.sku));

    // 2. Y después los del resultado, por código. Éstos son la lista que se
    //    puede recorrer sin escribir nada.
    const pasa = this.combosQuePasan();
    const delResultado = new Map<string, string | null>();
    for (const s of this.resultado()?.por_sku_tienda ?? []) {
      if (pasa && pasa[s.j] !== true) continue;
      if (!vistos.has(s.sku) && !delResultado.has(s.sku)) {
        delResultado.set(s.sku, s.descripcion ?? this.nombresDelCatalogo().get(s.sku) ?? null);
      }
    }

    return [
      ...opciones,
      ...[...delResultado]
        .map(([sku, d]) => etiquetar(sku, d))
        .sort((a, b) => a.sku.localeCompare(b.sku)),
    ];
  });

  readonly proveedoresDisponibles = computed(() =>
    [...new Set((this.resultado()?.proveedores ?? []).map((p) => p.nombre || p.proveedor_id))].sort(),
  );

  /** El catálogo de combinaciones de jerarquía comercial. Cada SKU y cada
   *  renglón del universo traen un índice a esta lista en vez de los cuatro
   *  textos: repetirlos costaba 1.3 MB de respuesta. */
  private readonly combos = computed(() => this.resultado()?.jerarquia ?? []);

  /** Los combos que de verdad aparecen en el resultado. El catálogo puede
   *  traer combinaciones que sólo usa el universo, y las opciones de los
   *  filtros salen de aquí. */
  private readonly combosVivos = computed(() => {
    const combos = this.combos();
    const usados = new Set<number>();
    for (const s of this.resultado()?.por_sku_tienda ?? []) usados.add(s.j);
    for (const u of this.resultado()?.detalle_dias?.universo ?? []) usados.add(u.j);
    return [...usados].map((j) => combos[j]).filter((c) => !!c);
  });

  /**
   * Las opciones de los cuatro niveles, EN CASCADA: cada uno se calcula
   * sobre los combos que ya sobrevivieron a los de arriba, así que elegir
   * "GOURMET" en Sección deja en Categoría sólo las que existen dentro de
   * Gourmet, y en Subcategoría sólo las de esa categoría.
   *
   * Se sacan del resultado y no del catálogo completo a propósito: si una
   * subcategoría no tuvo un solo faltante en el periodo, ofrecerla sería
   * mandar al usuario a una pantalla vacía. Y salen los cuatro de una
   * pasada, porque la lista se va recortando mientras se baja de nivel.
   */
  readonly opcionesNivel = computed(() => {
    let vivos = this.combosVivos();
    const opciones = {} as Record<Nivel, string[]>;
    NIVELES.forEach((n, nivel) => {
      opciones[n] = [
        ...new Set(vivos.map((c) => c[nivel]).filter((v): v is string => !!v)),
      ].sort();
      const puestas = this.filtroNivel[n]();
      if (puestas.length) vivos = vivos.filter((c) => this.coincideAlguna([c[nivel]], puestas));
    });
    return opciones;
  });

  /** Las vías presentes en el resultado. Van en la posición 4 del combo,
   *  después de los cuatro niveles comerciales. */
  readonly vias = computed(() =>
    [...new Set(this.combosVivos().map((c) => c[IDX_VIA])
      .filter((v): v is string => !!v))].sort(),
  );

  /** Los deciles presentes, en orden NATURAL: alfabéticamente "Decil 10" va
   *  antes que "Decil 2", que es justo al revés de como se lee. */
  readonly deciles = computed(() =>
    [...new Set(this.combosVivos().map((c) => c[IDX_DECIL])
      .filter((v): v is string => !!v))]
      .sort((a, b) => a.localeCompare(b, 'es', { numeric: true })),
  );

  /** Si el análisis corrió sin catálogo comercial (modo archivo, o la tabla
   *  todavía sin cargar) estos filtros no tienen nada que ofrecer: el bloque
   *  se esconde en vez de aparecer vacío y hacer creer que no hay datos. */
  readonly hayJerarquia = computed(() =>
    NIVELES.some((n) => this.opcionesNivel()[n].length > 0),
  );

  // -- opciones de los desplegables, sacadas de los propios datos ----------

  /** La tienda sobre la que corrió este análisis. Es una sola —el motor no
   *  admite más— y hace falta para preguntarle al catálogo. Se toma del sello
   *  de la corrida guardada, del formulario, o del propio resultado. */
  readonly tiendaDelAnalisis = computed(
    () =>
      this.resultado()?.guardado?.tienda ||
      this.tiendaSeleccionada() ||
      this.tiendas()[0] ||
      '',
  );

  readonly tiendas = computed(() =>
    [...new Set((this.resultado()?.por_sku_tienda ?? []).map((s) => s.tienda))].sort(),
  );

  /** id -> nombre. El resultado sólo trae la clave de tienda ("287"); el
   *  nombre vive en /api/tiendas, así que se cruzan aquí. Si la lista no
   *  llegó —modo archivo sin base, o la base caída— se cae a la clave sola:
   *  un combo con el id es peor que con el nombre, pero mucho mejor que uno
   *  vacío. */
  private readonly nombrePorTienda = computed(() => {
    const m = new Map<string, string>();
    for (const t of this.tiendasDisponibles()) if (t.nombre) m.set(t.tienda, t.nombre);
    return m;
  });

  etiquetaTienda(id: string): string {
    const nombre = this.nombrePorTienda().get(id);
    return nombre ? `${id} · ${nombre}` : id;
  }

  readonly causas = computed(() => {
    const vistas = new Map<string, string>();
    for (const s of this.resultado()?.por_sku_tienda ?? []) vistas.set(s.root_cause_id, s.causa);
    return [...vistas].map(([id, causa]) => ({ id, causa })).sort((a, b) => a.id.localeCompare(b.id));
  });

  readonly responsables = computed(() =>
    [...new Set((this.resultado()?.por_sku_tienda ?? []).map((s) => s.responsable))].sort(),
  );

  // -- listas filtradas ----------------------------------------------------
  //
  // SKU y proveedor son "cualquiera de los elegidos" (OR entre fichas), y ese
  // resultado se cruza con AND contra el resto de los filtros — mismo criterio
  // de siempre, sólo que ahora el de SKU/proveedor puede traer más de un valor.

  /** ¿alguno de `valores` (código, nombre, lo que aplique) contiene a alguna
   *  de las fichas ya elegidas? Vacío el arreglo de fichas = no filtra por
   *  esto. Un solo campo (proveedor) o varios (SKU: código + nombre) usan la
   *  misma función. */
  private coincideAlguna(valores: (string | null | undefined)[], elegidas: string[]): boolean {
    if (!elegidas.length) return true;
    const candidatos = valores.filter((v): v is string => !!v).map(normalizar);
    return elegidas.some((e) => {
      const buscado = normalizar(e);
      return candidatos.some((v) => v.includes(buscado));
    });
  }

  /**
   * ¿Qué combos de jerarquía pasan los filtros puestos? Un arreglo de
   * booleanos indexado por la misma `j` que traen los renglones.
   *
   * La gracia es que se decide UNA VEZ POR COMBO —unos miles— y no una vez
   * por renglón: el universo trae decenas de miles y los días, más. Y
   * cuando no hay ningún nivel puesto devuelve `null`, que las listas leen
   * como "no filtres" y les ahorra la vuelta entera.
   */
  private readonly combosQuePasan = computed<boolean[] | null>(() => {
    const puestas = NIVELES.map((n) => this.filtroNivel[n]());
    const via = this.filtroVia();
    const decil = this.filtroDecil();
    if (!via.length && !decil.length && !puestas.some((p) => p.length)) return null;
    // Un SKU sin ficha comercial (fuera del catálogo, RC00) cae en el combo
    // de puros nulos y no pertenece a ninguna sección: con un filtro puesto
    // queda fuera, también del denominador del waterfall.
    //
    // La vía va en el mismo arreglo que los niveles a propósito: los
    // renglones del universo indexan este catálogo, así que filtrar por vía
    // recompone el denominador del OSA sin código extra.
    return this.combos().map(
      (c) =>
        puestas.every((p, i) => this.coincideAlguna([c[i]], p)) &&
        this.coincideAlguna([c[IDX_VIA]], via) &&
        this.coincideAlguna([c[IDX_DECIL]], decil),
    );
  });

  readonly skusFiltrados = computed<FilaSkuTienda[]>(() => {
    const skus = this.filtroSku();
    const tienda = this.filtroTienda();
    const causa = this.filtroCausa();
    const resp = this.filtroResponsable();
    const pasa = this.combosQuePasan();
    return (this.resultado()?.por_sku_tienda ?? []).filter(
      (s) =>
        this.coincideAlguna([s.sku, s.descripcion], skus) &&
        (!tienda || s.tienda === tienda) &&
        (!causa || s.root_cause_id === causa) &&
        (!resp || s.responsable === resp) &&
        (!pasa || pasa[s.j] === true),
    );
  });

  readonly citasFiltradas = computed<CitaFallada[]>(() => {
    const skus = this.filtroSku();
    const provs = this.filtroProveedor();
    return (this.resultado()?.citas_falladas ?? []).filter(
      // La descripción se resuelve por código: las citas no la traen, y sin
      // esto buscar por nombre vaciaba esta tabla mientras el resto de la
      // pantalla sí respondía.
      (c) =>
        this.coincideAlguna([c.sku, this.descripcionDe(c.sku)], skus) &&
        this.coincideAlguna([c.proveedor], provs),
    );
  });

  /** El scorecard de proveedor es un agregado del periodo: no tiene columna de
   *  SKU, así que el filtro de SKU no puede tocarlo sin mentir. Se filtra sólo
   *  por nombre. Para ver el proveedor de un SKU está la tabla de citas. */
  /** Proveedores ordenados por nivel de servicio, PEOR PRIMERO.
   *
   *  Así la primera página —que son 10— es el Bottom 10 que se pidió, sin
   *  duplicar la tabla en una sección aparte: el que quiera ver el resto
   *  sigue paginando, y el filtro por proveedor sigue funcionando igual.
   *
   *  Los que no tienen nivel de servicio (ningún pedido en el periodo) van
   *  al final: sin denominador no son "los peores", son "no se sabe", y
   *  encabezar el ranking con ellos taparía a los que sí fallaron. */
  readonly proveedoresFiltrados = computed<FilaProveedor[]>(() => {
    const provs = this.filtroProveedor();
    return (this.resultado()?.proveedores ?? [])
      .filter((p) => this.coincideAlguna([p.nombre, p.proveedor_id], provs))
      .slice()
      .sort((a, b) => {
        const x = a.nivel_servicio, y = b.nivel_servicio;
        if (x === null && y === null) return b.cajas_pedidas - a.cajas_pedidas;
        if (x === null) return 1;
        if (y === null) return -1;
        // A igual nivel de servicio manda el volumen: fallarle a 10 mil cajas
        // pesa más que fallarle a diez.
        return x - y || b.cajas_pedidas - a.cajas_pedidas;
      });
  });

  // ========================================================================
  // WATERFALL Y PARETO, RECALCULADOS CON LOS FILTROS PUESTOS
  // ========================================================================
  //
  // Se recalculan aquí, en el navegador, a partir del detalle día por día
  // que manda el backend. No se pueden sacar de `por_sku_tienda`: esa tabla
  // trae la causa DOMINANTE de cada SKU, así que uno con RC01 unos días y
  // RC06 otros aparece como "100% RC01" — el Pareto saldría equivocado, no
  // sólo desactualizado.
  //
  // El filtro de proveedor NO entra: un día no tiene proveedor, lo tiene el
  // pedido. Cruzarlos aquí sería inventar una relación que el dato no trae.

  /** Los días que sobreviven a los filtros de SKU y tienda. Causa y
   *  responsable se aplican después, para que el denominador del waterfall
   *  no cambie al elegir una causa: el universo lo define qué SKU estás
   *  mirando, no qué causa. */
  private readonly diasDelAlcance = computed(() => {
    const det = this.resultado()?.detalle_dias;
    if (!det) return [];
    const skus = this.filtroSku();
    const tienda = this.filtroTienda();
    const pasa = this.combosQuePasan();
    const jDe = this.jPorSkuTienda();
    return det.dias.filter(
      (d) =>
        this.coincideAlguna([d.s, this.descripcionDe(d.s)], skus) &&
        (!tienda || d.t === tienda) &&
        (!pasa || pasa[jDe.get(d.s + '|' + d.t) ?? -1] === true),
    );
  });

  /** (sku|tienda) -> índice de jerarquía. Los días no traen `j` propio —son
   *  decenas de miles de renglones y cargarían ocho bytes cada uno— y no les
   *  hace falta: salen de la misma lista `en_alcance` que `por_sku_tienda`,
   *  así que su combo siempre está aquí. El universo sí lo trae, porque ése
   *  puede incluir SKU que no tuvieron ni un día con faltante. */
  private readonly jPorSkuTienda = computed(() => {
    const m = new Map<string, number>();
    for (const s of this.resultado()?.por_sku_tienda ?? []) m.set(s.sku + '|' + s.tienda, s.j);
    return m;
  });

  /** sku -> descripción, para que filtrar por nombre también recorte estos
   *  cálculos y no sólo la tabla de detalle. */
  private readonly descripcionPorSku = computed(() => {
    const m = new Map<string, string | null>();
    for (const s of this.resultado()?.por_sku_tienda ?? []) m.set(s.sku, s.descripcion);
    return m;
  });

  /** El nombre del producto. Sale del resultado si el SKU tuvo faltante, y
   *  del catálogo si está sano: `por_sku_tienda` sólo trae los primeros. */
  descripcionDe(sku: string): string | null {
    return this.descripcionPorSku().get(sku) ?? this.nombresDelCatalogo().get(sku) ?? null;
  }

  /** Las filas de BOPS del alcance que quedan bajo el filtro de SKU/tienda.
   *  Es el denominador del waterfall: sin recomponerlo, filtrar a un SKU
   *  dejaría los puntos de OSA calculados sobre la tienda entera. */
  private readonly universoFiltrado = computed(() => {
    const det = this.resultado()?.detalle_dias;
    if (!det) return 0;
    const skus = this.filtroSku();
    const tienda = this.filtroTienda();
    const pasa = this.combosQuePasan();
    return det.universo
      .filter(
        (u) =>
          this.coincideAlguna([u.s, this.descripcionDe(u.s)], skus) &&
          (!tienda || u.t === tienda) &&
          (!pasa || pasa[u.j] === true),
      )
      .reduce((a, u) => a + u.n, 0);
  });

  /** Los días ya con los cuatro filtros aplicados. */
  private readonly diasFiltrados = computed(() => {
    const det = this.resultado()?.detalle_dias;
    if (!det) return [];
    const causa = this.filtroCausa();
    const resp = this.filtroResponsable();
    return this.diasDelAlcance().filter((d) => {
      const c = det.causas[d.c];
      return (!causa || c.root_cause_id === causa) && (!resp || c.responsable === resp);
    });
  });

  readonly waterfallFiltrado = computed<Waterfall | null>(() => {
    const det = this.resultado()?.detalle_dias;
    const base = this.resultado()?.waterfall;
    if (!det || !base) return null;
    if (!this.hayFiltro()) return base;

    const universo = this.universoFiltrado();
    if (!universo) return { ...base, osa_real: null, universo_filas: 0, escalones: [] };

    // Se agrupa por CAUSA, no por el índice del catálogo. Desde que ese
    // catálogo distingue subcausas, un mismo RC01 vive en varias entradas —
    // "ignoró la alerta" y "nunca fue notificada" son índices distintos— y
    // agrupar por índice partía la causa en dos escalones que además
    // repetían la llave del @for. El backend agrupa por `causa_raiz`; esto
    // tiene que hacer lo mismo o el waterfall filtrado y el sin filtrar
    // dejan de decir lo mismo.
    const dias = new Map<string, { n: number; c: number }>();
    for (const d of this.diasFiltrados()) {
      const acc = dias.get(det.causas[d.c].causa) ?? { n: 0, c: d.c };
      acc.n += 1;
      dias.set(det.causas[d.c].causa, acc);
    }

    const escalones = [...dias]
      .map(([causa, acc]) => ({
        root_cause_id: det.causas[acc.c].root_cause_id,
        causa,
        responsable: det.causas[acc.c].responsable,
        dias: acc.n,
        puntos_osa: Math.round((acc.n / universo) * 10000) / 100,
      }))
      .sort((a, b) => b.puntos_osa - a.puntos_osa);

    const perdidos = escalones.reduce((a, e) => a + e.puntos_osa, 0);
    return {
      osa_teorico: 100,
      osa_real: Math.round((100 - perdidos) * 10) / 10,
      universo_filas: universo,
      escalones,
    };
  });

  /** Agrega los días filtrados por una llave de la causa (id o responsable).
   *  Los dos Pareto son el mismo cálculo con distinto agrupador. */
  private paretoPor(porResponsable: boolean): FilaCausa[] {
    const det = this.resultado()?.detalle_dias;
    if (!det) return [];
    const acc = new Map<string, { dias: number; vp: number; c: number }>();
    for (const d of this.diasFiltrados()) {
      const c = det.causas[d.c];
      const llave = porResponsable ? c.responsable : c.causa;
      const a = acc.get(llave) ?? { dias: 0, vp: 0, c: d.c };
      a.dias += 1;
      a.vp += d.v;
      acc.set(llave, a);
    }
    const total = [...acc.values()].reduce((a, x) => a + x.vp, 0);
    return [...acc]
      .map(([llave, a]) => ({
        root_cause_id: det.causas[a.c].root_cause_id,
        causa: llave,
        responsable: det.causas[a.c].responsable,
        dias: a.dias,
        venta_perdida: Math.round(a.vp * 100) / 100,
        pct: total ? Math.round((a.vp / total) * 1000) / 10 : 0,
      }))
      .sort((x, y) => y.venta_perdida - x.venta_perdida || y.dias - x.dias);
  }

  readonly porCausaFiltrado = computed<FilaCausa[]>(() =>
    this.hayFiltro() ? this.paretoPor(false) : (this.resultado()?.por_causa ?? []),
  );

  readonly porResponsableFiltrado = computed<FilaResponsable[]>(() =>
    this.hayFiltro()
      ? this.paretoPor(true).map(({ causa, dias, venta_perdida, pct }) => ({
          responsable: causa,
          dias,
          venta_perdida,
          pct,
        }))
      : (this.resultado()?.por_responsable ?? []),
  );

  /** El desglose fino, recalculado sobre los días filtrados.
   *
   *  Mismo criterio que el backend: los días sin subcausa no cuentan —la
   *  subcausa sólo existe en las prioridades 3 y 8—, así que esta tabla suma
   *  menos días que los Pareto de arriba. No es un descuadre: es que no toda
   *  causa raíz tiene detalle. */
  readonly porSubcausaFiltrado = computed<FilaSubcausa[]>(() => {
    if (!this.hayFiltro()) return this.resultado()?.por_subcausa ?? [];
    const det = this.resultado()?.detalle_dias;
    if (!det) return [];
    const acc = new Map<string, { dias: number; vp: number }>();
    for (const d of this.diasFiltrados()) {
      const sub = det.causas[d.c].subcausa;
      if (!sub) continue;
      const a = acc.get(sub) ?? { dias: 0, vp: 0 };
      a.dias += 1;
      a.vp += d.v;
      acc.set(sub, a);
    }
    return [...acc]
      .map(([subcausa, a]) => ({
        subcausa,
        dias: a.dias,
        venta_perdida: Math.round(a.vp * 100) / 100,
      }))
      .sort((x, y) => y.venta_perdida - x.venta_perdida || y.dias - x.dias);
  });

  // -- ficha del/los SKU buscados ------------------------------------------

  /** Los renglones de los SKU elegidos, ignorando los demás filtros: si
   *  alguien busca un SKU y además tiene puesto un filtro de causa, la ficha
   *  debe hablar del SKU completo y no del recorte. */
  private readonly renglonesDelSku = computed<FilaSkuTienda[]>(() => {
    const skus = this.filtroSku();
    if (!skus.length) return [];
    return (this.resultado()?.por_sku_tienda ?? []).filter((s) =>
      this.coincideAlguna([s.sku, s.descripcion], skus),
    );
  });

  /** Los SKU del alcance que NO tuvieron ni un día con faltante. Salen del
   *  universo menos los que traen renglón en `por_sku_tienda`. */
  private readonly skusSanos = computed(() => {
    const conFaltante = new Set(
      (this.resultado()?.por_sku_tienda ?? []).map((s) => s.sku),
    );
    const sanos = new Map<string, string>();
    for (const u of this.resultado()?.detalle_dias?.universo ?? []) {
      if (!conFaltante.has(u.s)) sanos.set(u.s, u.t);
    }
    return sanos;
  });

  /** Se buscó un SKU, no tiene faltantes, pero SÍ está en el alcance.
   *
   *  Sin esto la pantalla se quedaba en blanco y parecía que el análisis no
   *  cubría el producto. Decirlo es la mitad del valor: "está dentro y su OSA
   *  fue 100%" es un resultado, no un vacío. */
  readonly fichaSano = computed(() => {
    if (this.renglonesDelSku().length) return null;
    const buscados = this.filtroSku();
    if (!buscados.length) return null;
    const sanos = this.skusSanos();
    const hallados = buscados
      .map((b) => [...sanos].find(([sku]) => normalizar(sku) === normalizar(b)))
      .filter((x): x is [string, string] => !!x);
    if (!hallados.length) return null;
    const [sku, tienda] = hallados[0];
    return { sku, tienda, cuantos: hallados.length, descripcion: this.descripcionDe(sku) };
  });

  readonly fichaSku = computed(() => {
    const filas = this.renglonesDelSku();
    if (!filas.length) return null;
    const skus = new Set(filas.map((f) => f.sku));
    return {
      sku: skus.size === 1 ? [...skus][0] : `${skus.size} SKU`,
      tiendas: new Set(filas.map((f) => f.tienda)).size,
      diasConFaltante: filas.reduce((a, f) => a + f.dias_con_faltante, 0),
      diasClasificados: filas.reduce((a, f) => a + f.dias_clasificados, 0),
      ventaPerdida: filas.reduce((a, f) => a + f.venta_perdida, 0),
      causas: [...new Set(filas.map((f) => `${f.root_cause_id} · ${f.causa}`))],
      citas: this.citasFiltradas().length,
    };
  });

  /** Se buscó un SKU y no tiene un solo día que explicar: o está sano, o
   *  está fuera del catálogo. Da igual cuál — el análisis de abajo habla del
   *  periodo completo y no de él, así que enseñarlo invita a leerlo como si
   *  fuera suyo. El scorecard de proveedor es el peor: no tiene columna de
   *  SKU, así que se quedaba mostrando los 689 proveedores de la tienda al
   *  lado de una tarjeta que dice "este producto no tuvo faltantes". */
  readonly sinNadaQueExplicar = computed(
    () => !!this.filtroSku().length && this.renglonesDelSku().length === 0,
  );

  /** Se buscó un SKU, no salió en el análisis, y TAMPOCO está en el alcance.
   *
   *  Antes este aviso cubría dos casos —el sano y el fuera de catálogo— y
   *  tenía que pedirle al usuario que corriera un script para distinguirlos.
   *  Desde que el sano tiene su propia tarjeta (ver `fichaSano`), aquí sólo
   *  queda el segundo, y ya se puede afirmar cuál es en vez de enumerar. */
  readonly skuFueraDeAlcance = computed(
    () => this.sinNadaQueExplicar() && this.fichaSano() === null,
  );

  // -- paginadores ---------------------------------------------------------
  //
  // Se declaran después de las listas: los campos de clase se inicializan en
  // orden y cada paginador necesita su señal ya construida.

  readonly pgSkus = new Paginador(this.skusFiltrados);
  readonly pgProveedores = new Paginador(this.proveedoresFiltrados);
  readonly pgCitas = new Paginador(this.citasFiltradas);
  readonly pgCausas = new Paginador(this.porCausaFiltrado);
  readonly pgResponsables = new Paginador(this.porResponsableFiltrado);
  readonly pgSubcausas = new Paginador(this.porSubcausaFiltrado);
  readonly pgBloqueos = new Paginador(computed(() => this.resultado()?.cobertura?.bloqueos ?? []));

  private reiniciarPaginas(): void {
    for (const p of [this.pgSkus, this.pgProveedores, this.pgCitas,
                     this.pgCausas, this.pgResponsables, this.pgSubcausas]) p.reiniciar();
  }

  // -- handlers ------------------------------------------------------------

  /**
   * ¿Este `input` lo escribió el usuario, o lo metió el navegador al elegir
   * una sugerencia del `<datalist>`?
   *
   * Importa porque elegir con el mouse dispara `input`, NUNCA `keydown`: sin
   * distinguirlo, hacer clic en una sugerencia dejaba el texto en la caja y
   * no agregaba nada, que es justo lo que uno espera de un autocompletar.
   *
   * `insertReplacementText` es la señal estándar y la que manda Chrome. El
   * segundo caso cubre a los navegadores que no la mandan (y de paso el
   * pegar): vale sólo si el valor **saltó** más de un carácter, porque
   * comparar el texto contra la lista a secas se rompe con los proveedores
   * —"MONDELEZ MEXICO" es una opción y a la vez prefijo de "MONDELEZ MEXICO
   * S DE R.L. DE C.V."— y auto-agregaría el corto a media palabra.
   */
  private vinoDeLaLista(e: Event, previo: string, valor: string, opciones: string[]): boolean {
    if ((e as InputEvent).inputType === 'insertReplacementText') return true;
    if (valor.length - previo.length <= 1) return false;
    return opciones.some((o) => normalizar(o) === normalizar(valor));
  }

  /** Sólo captura lo que se va escribiendo — no filtra todavía. El
   *  `<datalist>` sugiere de `opcionesSku()` mientras tanto. */
  ponEntradaSku(e: Event): void {
    const previo = this.entradaSku();
    const valor = (e.target as HTMLInputElement).value;
    this.entradaSku.set(valor);
    this.tecleoSku.next(valor);
    if (this.vinoDeLaLista(e, previo, valor, this.opcionesSku().map((o) => o.etiqueta))) {
      this.confirmarSku();
    }
  }

  ponEntradaProveedor(e: Event): void {
    const previo = this.entradaProveedor();
    const valor = (e.target as HTMLInputElement).value;
    this.entradaProveedor.set(valor);
    if (this.vinoDeLaLista(e, previo, valor, this.proveedoresDisponibles())) {
      this.confirmarProveedor();
    }
  }

  /** Enter agrega la ficha. Elegir del `<datalist>` la agrega sola, sin
   *  pedir Enter. */
  agregarSku(e: KeyboardEvent): void {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    this.confirmarSku();
  }

  agregarProveedor(e: KeyboardEvent): void {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    this.confirmarProveedor();
  }

  /** Si el texto es la etiqueta completa de una sugerencia ("código —
   *  nombre"), la ficha se queda sólo con el código: no necesita cargar el
   *  nombre. Cualquier otro texto se agrega tal cual — no hace falta que
   *  exista en este periodo para poder buscarlo. */
  private confirmarSku(): void {
    const escrito = this.entradaSku().trim();
    if (!escrito) return;
    const opcion = this.opcionesSku().find((o) => normalizar(o.etiqueta) === normalizar(escrito));
    const valor = opcion?.sku ?? escrito;
    if (!this.filtroSku().some((s) => normalizar(s) === normalizar(valor))) {
      this.filtroSku.update((skus) => [...skus, valor]);
      this.reiniciarPaginas();
    }
    this.entradaSku.set('');
  }

  private confirmarProveedor(): void {
    const valor = this.entradaProveedor().trim();
    if (!valor) return;
    if (!this.filtroProveedor().some((p) => normalizar(p) === normalizar(valor))) {
      this.filtroProveedor.update((provs) => [...provs, valor]);
      this.reiniciarPaginas();
    }
    this.entradaProveedor.set('');
  }

  /** Los cuatro niveles se manejan con los mismos tres handlers: sólo cambia
   *  cuál señal tocan. Misma mecánica que SKU y proveedor —Enter agrega,
   *  elegir del `<datalist>` agrega solo. */
  ponEntradaNivel(e: Event, n: Nivel): void {
    const previo = this.entradaNivel[n]();
    const valor = (e.target as HTMLInputElement).value;
    this.entradaNivel[n].set(valor);
    if (this.vinoDeLaLista(e, previo, valor, this.opcionesNivel()[n])) this.confirmarNivel(n);
  }

  agregarNivel(e: KeyboardEvent, n: Nivel): void {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    this.confirmarNivel(n);
  }

  private confirmarNivel(n: Nivel): void {
    const valor = this.entradaNivel[n]().trim();
    if (!valor) return;
    if (!this.filtroNivel[n]().some((x) => normalizar(x) === normalizar(valor))) {
      this.filtroNivel[n].update((xs) => [...xs, valor]);
      this.reiniciarPaginas();
    }
    this.entradaNivel[n].set('');
  }

  /** Quitar una ficha NO borra las de los niveles de abajo: quedaron elegidas
   *  a propósito y siguen filtrando por su cuenta. Para empezar de cero está
   *  "Limpiar". */
  quitarNivel(n: Nivel, valor: string): void {
    this.filtroNivel[n].update((xs) => xs.filter((x) => x !== valor));
    this.reiniciarPaginas();
  }

  quitarSku(sku: string): void {
    this.filtroSku.update((skus) => skus.filter((s) => s !== sku));
    this.reiniciarPaginas();
  }

  quitarProveedor(prov: string): void {
    this.filtroProveedor.update((provs) => provs.filter((p) => p !== prov));
    this.reiniciarPaginas();
  }

  ponTienda(e: Event): void {
    this.filtroTienda.set((e.target as HTMLSelectElement).value);
    this.reiniciarPaginas();
  }

  /** Prende o apaga un valor de un filtro de fichas. Son conjuntos chicos y
   *  cerrados —3 vías, 10 deciles— así que se muestran todas las opciones y
   *  se alternan con un clic, en vez de abrir un desplegable por cada una.
   *
   *  Reinicia la paginación como los demás filtros: si estabas en la página
   *  4 y el filtro deja tres renglones, la tabla se vería vacía. */
  private alternar(sen: WritableSignal<string[]>, valor: string): void {
    const puestas = sen();
    sen.set(puestas.includes(valor)
      ? puestas.filter((v) => v !== valor)
      : [...puestas, valor]);
    this.reiniciarPaginas();
  }

  alternarVia(v: string): void {
    this.alternar(this.filtroVia, v);
  }

  alternarDecil(d: string): void {
    this.alternar(this.filtroDecil, d);
  }

  ponCausa(e: Event): void {
    this.filtroCausa.set((e.target as HTMLSelectElement).value);
    this.reiniciarPaginas();
  }

  ponResponsable(e: Event): void {
    this.filtroResponsable.set((e.target as HTMLSelectElement).value);
    this.reiniciarPaginas();
  }

  limpiarFiltros(): void {
    this.filtroSku.set([]);
    this.entradaSku.set('');
    this.filtroTienda.set('');
    this.filtroCausa.set('');
    this.filtroResponsable.set('');
    this.filtroVia.set([]);
    this.filtroDecil.set([]);
    this.filtroProveedor.set([]);
    this.entradaProveedor.set('');
    for (const n of NIVELES) {
      this.filtroNivel[n].set([]);
      this.entradaNivel[n].set('');
    }
    // Y las cajas por su cuenta: ver `cajasFiltro`. Limpiar tiene que dejar
    // la pantalla como recién llegó, texto a medio escribir incluido.
    for (const caja of this.cajasFiltro()) caja.nativeElement.value = '';
    this.reiniciarPaginas();
  }

  /** Desde el top de portada: clic en un SKU y la pantalla se filtra a él
   *  (reemplaza la selección — es "ver este SKU", no "agregar otro más"). */
  verSku(sku: string): void {
    this.filtroSku.set([sku]);
    this.reiniciarPaginas();
    this.verDetalle.set(true);
    document.getElementById('filtros')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // -- detalle diario por SKU (evolución diaria) ----------------------------
  //
  // Sólo disponible cuando el análisis vino del modo "tienda" (datos ya en
  // Postgres): ahí sí hay tienda + periodo garantizados. Un análisis por
  // archivo puede traer un SKU que ni siquiera esté cargado en la base.

  readonly expedienteAbierto = signal<Expediente | null>(null);
  readonly cargandoExpediente = signal(false);
  readonly errorExpediente = signal<string | null>(null);

  verExpediente(sku: string, tienda: string): void {
    // El periodo sale del formulario, y si no está, del sello de la corrida
    // guardada. Antes esto se salía en silencio cuando faltaba: el botón no
    // hacía nada y no había forma de saber por qué.
    const g = this.resultado()?.guardado;
    const desde = this.fechaDesde() || g?.desde;
    const hasta = this.fechaHasta() || g?.hasta;
    if (!desde || !hasta) {
      this.errorExpediente.set(
        'No se sabe de qué periodo pedir el detalle. Vuelve a abrir la corrida.');
      return;
    }

    this.cargandoExpediente.set(true);
    this.errorExpediente.set(null);
    this.expedienteAbierto.set(null);

    this.api.expediente(tienda, sku, desde, hasta).subscribe({
      next: (e) => {
        this.expedienteAbierto.set(e);
        this.cargandoExpediente.set(false);
        document.getElementById('expediente')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
      error: (e) => {
        this.errorExpediente.set(e?.error?.detail ?? 'No se pudo cargar el detalle diario.');
        this.cargandoExpediente.set(false);
      },
    });
  }

  /** ¿Se puede pedir el detalle diario de un SKU?
   *
   *  La condición real es tener un periodo con el que preguntarle a la API:
   *  el del formulario cuando el análisis se acaba de correr, o el de la
   *  corrida al abrirla del histórico. Antes el botón se ataba a
   *  `modo() === 'tienda'`, y al abrir una corrida guardada el modo seguía en
   *  'archivo', así que el botón simplemente no se pintaba.
   *
   *  El modo archivo sigue quedando fuera, y con razón: no tiene periodo, y
   *  el expediente lee de Postgres y no del archivo que subieron. */
  readonly puedeVerExpediente = computed(() => {
    const g = this.resultado()?.guardado;
    return !!((this.fechaDesde() || g?.desde) && (this.fechaHasta() || g?.hasta));
  });

  cerrarExpediente(): void {
    this.expedienteAbierto.set(null);
    this.errorExpediente.set(null);
  }

  /** Máximo de cada métrica dentro del periodo mostrado — igual que
   *  `escalonMayor` del waterfall: cada barra escala contra el máximo de su
   *  propia lista, no contra un total absoluto, para que un valor chico no
   *  desaparezca. */
  // -- escalas de la evolución diaria --------------------------------------
  //
  // Antes cada serie se escalaba contra SU PROPIO máximo: tres reglas
  // distintas en el mismo dibujo, así que comparar alturas no significaba
  // nada — un inventario de 3 podía verse más alto que una venta de 15.
  //
  // Ahora existencia en tienda y venta comparten una sola escala: son el
  // mismo lugar y la misma unidad (piezas), y compararlas es justo la
  // pregunta útil ("¿se vendió mientras había stock?").
  //
  // CEDIS va aparte, con su propia escala y su máximo escrito, porque su
  // magnitud no es comparable: medido sobre los datos reales va de 10 a 500
  // veces el inventario de tienda (un SKU con 4,421 en tienda tiene 105,504
  // en CEDIS). Metido en la misma regla dejaría la venta en 0.18% de altura,
  // o sea invisible. Son small multiples, no dos ejes en una gráfica.

  /** Techo compartido de tienda y venta. */
  readonly maximoTienda = computed(() => {
    const dias = this.expedienteAbierto()?.dias ?? [];
    return Math.max(
      ...dias.map((d) => Math.max(d.existencia_tienda ?? 0, d.unidades_vendidas ?? 0)),
      0.01,
    );
  });

  readonly maximoCedis = computed(() => {
    const dias = this.expedienteAbierto()?.dias ?? [];
    return Math.max(...dias.map((d) => d.existencia_cedis ?? 0), 0.01);
  });

  /** ¿Vale la pena dibujar la fila de CEDIS? Sólo el 11% de los SKU tienen
   *  inventario de CEDIS cargado; para el resto sería una fila vacía. */
  /** ¿Se dibuja la fila de inventario de CEDIS?
   *
   *  Dos condiciones, y la primera es de negocio: sólo en Vía 1 el CEDIS
   *  resguarda producto. En Vía 2 hace crossdock, así que su existencia es
   *  cero por diseño y la barra hacía pensar que el CEDIS estaba
   *  desabastecido cuando esa es su operación normal.
   *
   *  La segunda es de dibujo: aunque resguarde, sin un solo día con dato la
   *  fila saldría vacía y sólo ocuparía espacio. */
  readonly hayInventarioCedis = computed(() => {
    const ex = this.expedienteAbierto();
    if (!ex?.cedis_resguarda) return false;
    return ex.dias.some((d) => d.existencia_cedis !== null);
  });

  altoBarraDia(valor: number | null, escala: 'tienda' | 'cedis' = 'tienda'): string {
    if (valor === null) return '0%';
    const techo = escala === 'cedis' ? this.maximoCedis() : this.maximoTienda();
    // El mínimo de 2% es para que un valor pequeño pero real no desaparezca.
    // El cero se dibuja en cero: es un dato, no un valor chico.
    return valor === 0 ? '0%' : `${Math.max((valor / techo) * 100, 2)}%`;
  }

  /** Las causas que de verdad aparecen en ESTE SKU, para la leyenda.
   *
   *  La leyenda no es decorativa: con seis causas el color no separa lo
   *  suficiente —ninguna combinación clarea la prueba de daltonismo con
   *  todos los pares—, así que la identidad tiene que estar escrita. Sale
   *  corta porque un SKU rara vez toca más de dos o tres causas. */
  readonly causasDelExpediente = computed(() => {
    const vistas = new Map<string, string>();
    for (const d of this.expedienteAbierto()?.dias ?? []) {
      if (d.root_cause_id) vistas.set(d.root_cause_id, d.causa_raiz ?? d.root_cause_id);
    }
    return [...vistas].map(([id, causa]) => ({ id, causa })).sort((a, b) => a.id.localeCompare(b.id));
  });

  // -- cuánta historia hay cargada ----------------------------------------
  //
  // Los paneles de tendencia del boceto piden seis meses. Se sale de la
  // ventana que reporta BOPS_OSA, que es la fuente que define qué días entran
  // al análisis — no del periodo pedido, que puede ser más ancho que el dato.

  private readonly ventanaBops = computed(() =>
    (this.resultado()?.fuentes ?? []).find((f) => f.hoja === 'BOPS_OSA') ?? null,
  );

  readonly diasDeHistoria = computed(() => {
    const f = this.ventanaBops();
    if (!f?.desde || !f?.hasta) return 0;
    const ms = new Date(f.hasta).getTime() - new Date(f.desde).getTime();
    return Math.round(ms / 86_400_000) + 1;
  });

  /** Los paneles de tendencia se dibujan sólo si el interruptor está en true.
   *  Apagados por ahora: piden seis meses y hay 43 días. */
  readonly mostrarPanelesSinDatos = MOSTRAR_PANELES_SIN_DATOS;

  /** Cuántos días con hueco tuvo un SKU en promedio durante el periodo.
   *
   *  El conteo crudo —43,821 días— no le dice nada a nadie: no hay con qué
   *  compararlo de memoria. "12 días de 31" sí se entiende solo.
   *
   *  OJO CON EL DENOMINADOR: son TODOS los SKU del alcance, no sólo los que
   *  tuvieron hueco. Un SKU que estuvo disponible todo el mes cuenta como
   *  cero días y baja el promedio — que es justo lo que se quiere medir. Si
   *  se dividiera sólo entre los que fallaron, el número diría "qué tan malo
   *  fue el que falló", no "cómo estuvo el surtido".
   *
   *  Sale de `detalle_dias.universo`, que trae una entrada por SKU-tienda
   *  medido, con o sin faltante. No hace falta tocar el backend.
   */
  readonly promedioDiasConGapPorSku = computed(() => {
    const r = this.resultado();
    const det = r?.detalle_dias;
    if (!det?.universo?.length) return null;
    const skus = new Set(det.universo.map((u) => u.s)).size;
    return skus ? (r?.cobertura?.casos_en_alcance ?? 0) / skus : null;
  });

  /** Los días que cubre el periodo, para leer el promedio contra su techo:
   *  12 de 31 dice mucho más que 12 a secas. */
  readonly diasDelPeriodo = computed(() => this.diasDeHistoria());

  /** Qué tienda(s) cubre el resultado, con nombre.
   *
   *  Sale de `por_sku_tienda` y no del formulario: el formulario puede
   *  cambiar después de correr el análisis, y lo que hay que encabezar es lo
   *  que se analizó, no lo que está seleccionado ahora. Con varias tiendas
   *  cargadas, la clave sola no basta para saber cuál se está viendo. */
  readonly tiendasAnalizadas = computed(() =>
    [...new Set((this.resultado()?.por_sku_tienda ?? []).map((s) => s.tienda))]
      .sort()
      .map((id) => this.etiquetaTienda(id)),
  );

  readonly rangoHistoria = computed(() => {
    const f = this.ventanaBops();
    return f?.desde && f?.hasta ? `${f.desde} a ${f.hasta}` : null;
  });

  // -- ayudas de presentación ---------------------------------------------

  color(rc: string): string {
    return COLOR_CAUSA[rc] ?? '#8a8a95';
  }

  /** Alias de `color`. Se conserva porque la tira del expediente lo llama por
   *  su nombre viejo, de cuando había dos paletas. */
  colorTira(rc: string): string {
    return this.color(rc);
  }

  /** Semáforo del cumplimiento del proveedor: mismos cortes que el Excel. */
  semaforo(tasa: number | null): string {
    if (tasa === null) return 'nd';
    if (tasa >= 0.95) return 'bien';
    return tasa >= 0.8 ? 'medio' : 'mal';
  }

  /** Una hoja vacía se pinta en rojo en la tabla de fuentes. La de SIMA no,
   *  mientras su ausencia sea esperada: dejarla roja contradiría el resto de
   *  la pantalla, donde ya no se dice nada al respecto. */
  fuenteEnRojo(hoja: string, filas: number): boolean {
    if (filas > 0) return false;
    return !(OCULTAR_AVISOS_SIMA && hoja.includes('SIMA'));
  }
}
