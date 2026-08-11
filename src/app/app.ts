import { DecimalPipe, PercentPipe, SlicePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';
import { Analisis, CitaFallada, Expediente, FilaProveedor, FilaSkuTienda, Orcmm, Tienda } from './orcmm';
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

/** Colores de la matriz, los mismos del Excel de resultados. */
const COLOR_CAUSA: Record<string, string> = {
  RC01: '#DDEBF7',
  RC02: '#FFEB9C',
  RC03: '#FFC7CE',
  RC04: '#FFEB9C',
  RC05: '#FFC7CE',
  RC06: '#FFC7CE',
  RC99: '#F2F2F2',
};

@Component({
  selector: 'app-root',
  imports: [DecimalPipe, PercentPipe, SlicePipe, PaginadorCtrl],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly api = inject(Orcmm);

  readonly paso = signal<Paso>('inicio');
  readonly archivos = signal<File[]>([]);
  readonly resultado = signal<Analisis | null>(null);
  readonly error = signal<string | null>(null);
  readonly arrastrando = signal(false);
  readonly verDetalle = signal(false);
  /** Cuánto lleva EN SU FASE actual, según el backend. */
  readonly segundos = signal(0);
  readonly fase = signal<'en_cola' | 'corriendo'>('corriendo');
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
    this.delante.set(0);
    this.cancelando.set(false);

    flujo.subscribe({
      next: (r) => {
        this.idEnVuelo.set(r.id);
        if (r.estado === 'en_proceso') {
          this.segundos.set(r.segundos ?? 0);
          this.fase.set(r.fase ?? 'corriendo');
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
  readonly topSkus = computed(() => this.skusFiltrados().slice(0, 6));

  private readonly ventaMayor = computed(() =>
    Math.max(...this.topSkus().map((s) => s.venta_perdida), 1),
  );

  anchoSku(venta: number): string {
    return `${Math.max((venta / this.ventaMayor()) * 100, 2)}%`;
  }

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
  readonly filtroResponsable = signal('');
  readonly filtroProveedor = signal<string[]>([]);
  readonly entradaProveedor = signal('');

  readonly hayFiltro = computed(
    () =>
      !!(
        this.filtroSku().length ||
        this.filtroTienda() ||
        this.filtroCausa() ||
        this.filtroResponsable() ||
        this.filtroProveedor().length
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
    const vistos = new Map<string, string | null>();
    for (const s of this.resultado()?.por_sku_tienda ?? []) {
      if (!vistos.has(s.sku)) vistos.set(s.sku, s.descripcion);
    }
    return [...vistos]
      .map(([sku, descripcion]) => ({
        sku,
        descripcion,
        etiqueta: descripcion ? `${sku} — ${descripcion}` : sku,
      }))
      .sort((a, b) => a.sku.localeCompare(b.sku));
  });

  readonly proveedoresDisponibles = computed(() =>
    [...new Set((this.resultado()?.proveedores ?? []).map((p) => p.nombre || p.proveedor_id))].sort(),
  );

  // -- opciones de los desplegables, sacadas de los propios datos ----------

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

  readonly skusFiltrados = computed<FilaSkuTienda[]>(() => {
    const skus = this.filtroSku();
    const tienda = this.filtroTienda();
    const causa = this.filtroCausa();
    const resp = this.filtroResponsable();
    return (this.resultado()?.por_sku_tienda ?? []).filter(
      (s) =>
        this.coincideAlguna([s.sku, s.descripcion], skus) &&
        (!tienda || s.tienda === tienda) &&
        (!causa || s.root_cause_id === causa) &&
        (!resp || s.responsable === resp),
    );
  });

  readonly citasFiltradas = computed<CitaFallada[]>(() => {
    const skus = this.filtroSku();
    const provs = this.filtroProveedor();
    return (this.resultado()?.citas_falladas ?? []).filter(
      (c) => this.coincideAlguna([c.sku], skus) && this.coincideAlguna([c.proveedor], provs),
    );
  });

  /** El scorecard de proveedor es un agregado del periodo: no tiene columna de
   *  SKU, así que el filtro de SKU no puede tocarlo sin mentir. Se filtra sólo
   *  por nombre. Para ver el proveedor de un SKU está la tabla de citas. */
  readonly proveedoresFiltrados = computed<FilaProveedor[]>(() => {
    const provs = this.filtroProveedor();
    return (this.resultado()?.proveedores ?? []).filter((p) =>
      this.coincideAlguna([p.nombre, p.proveedor_id], provs),
    );
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

  /** Se buscó un SKU y no salió en el análisis. No es un error de búsqueda y
   *  hay que decir por qué, porque son dos razones muy distintas y ninguna
   *  significa "no existe". */
  readonly skuSinFaltantes = computed(
    () => !!this.filtroSku().length && this.renglonesDelSku().length === 0,
  );

  // -- paginadores ---------------------------------------------------------
  //
  // Se declaran después de las listas: los campos de clase se inicializan en
  // orden y cada paginador necesita su señal ya construida.

  readonly pgSkus = new Paginador(this.skusFiltrados);
  readonly pgProveedores = new Paginador(this.proveedoresFiltrados);
  readonly pgCitas = new Paginador(this.citasFiltradas);
  readonly pgCausas = new Paginador(computed(() => this.resultado()?.por_causa ?? []));
  readonly pgResponsables = new Paginador(computed(() => this.resultado()?.por_responsable ?? []));
  readonly pgSubcausas = new Paginador(computed(() => this.resultado()?.por_subcausa ?? []));
  readonly pgBloqueos = new Paginador(computed(() => this.resultado()?.cobertura?.bloqueos ?? []));

  private reiniciarPaginas(): void {
    for (const p of [this.pgSkus, this.pgProveedores, this.pgCitas]) p.reiniciar();
  }

  // -- handlers ------------------------------------------------------------

  /** Sólo captura lo que se va escribiendo — no filtra todavía. El
   *  `<datalist>` sugiere de `opcionesSku()` mientras tanto. */
  ponEntradaSku(e: Event): void {
    this.entradaSku.set((e.target as HTMLInputElement).value);
  }

  ponEntradaProveedor(e: Event): void {
    this.entradaProveedor.set((e.target as HTMLInputElement).value);
  }

  /** Enter (o elegir una sugerencia y darle Enter) agrega la ficha. Si el
   *  texto es la etiqueta completa de una sugerencia ("código — nombre"),
   *  se queda sólo con el código — la ficha no necesita cargar el nombre.
   *  Cualquier otro texto se agrega tal cual, igual que antes: no hace
   *  falta que exista en este periodo para poder buscarlo. */
  agregarSku(e: KeyboardEvent): void {
    if (e.key !== 'Enter') return;
    e.preventDefault();
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

  agregarProveedor(e: KeyboardEvent): void {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const valor = this.entradaProveedor().trim();
    if (!valor) return;
    if (!this.filtroProveedor().some((p) => normalizar(p) === normalizar(valor))) {
      this.filtroProveedor.update((provs) => [...provs, valor]);
      this.reiniciarPaginas();
    }
    this.entradaProveedor.set('');
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
    this.filtroProveedor.set([]);
    this.entradaProveedor.set('');
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
    const desde = this.fechaDesde();
    const hasta = this.fechaHasta();
    if (!desde || !hasta) return;

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

  cerrarExpediente(): void {
    this.expedienteAbierto.set(null);
    this.errorExpediente.set(null);
  }

  /** Máximo de cada métrica dentro del periodo mostrado — igual que
   *  `escalonMayor` del waterfall: cada barra escala contra el máximo de su
   *  propia lista, no contra un total absoluto, para que un valor chico no
   *  desaparezca. */
  private maximoDia(campo: 'existencia_tienda' | 'unidades_vendidas' | 'existencia_cedis'): number {
    const dias = this.expedienteAbierto()?.dias ?? [];
    return Math.max(...dias.map((d) => d[campo] ?? 0), 0.01);
  }

  altoBarraDia(valor: number | null, campo: 'existencia_tienda' | 'unidades_vendidas' | 'existencia_cedis'): string {
    if (valor === null) return '0%';
    return `${Math.max((valor / this.maximoDia(campo)) * 100, 2)}%`;
  }

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

  readonly rangoHistoria = computed(() => {
    const f = this.ventanaBops();
    return f?.desde && f?.hasta ? `${f.desde} a ${f.hasta}` : null;
  });

  // -- ayudas de presentación ---------------------------------------------

  color(rc: string): string {
    return COLOR_CAUSA[rc] ?? '#F2F2F2';
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
