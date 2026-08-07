import { DecimalPipe, PercentPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { Analisis, Orcmm } from './orcmm';

type Paso = 'inicio' | 'trabajando' | 'bloqueado' | 'listo' | 'sin-datos' | 'error';

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
  imports: [DecimalPipe, PercentPipe],
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
  /** Cuánto lleva corriendo el análisis, según el backend. */
  readonly segundos = signal(0);

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

    this.paso.set('trabajando');
    this.error.set(null);
    this.segundos.set(0);

    this.api.analizar(archivos, corregir, forzar).subscribe({
      next: (r) => {
        if (r.estado === 'en_proceso') {
          this.segundos.set(r.segundos ?? 0);
          return;
        }
        this.resultado.set(r);
        this.paso.set(
          r.estado === 'ok' ? 'listo' : r.estado === 'sin_datos' ? 'sin-datos' : 'bloqueado',
        );
      },
      error: (e) => {
        this.error.set(
          e?.error?.detail ??
            'No se pudo contactar al backend. Revisar que esté corriendo en el puerto 8000.',
        );
        this.paso.set('error');
      },
    });
  }

  reiniciar(): void {
    this.archivos.set([]);
    this.resultado.set(null);
    this.error.set(null);
    this.verDetalle.set(false);
    this.segundos.set(0);
    this.paso.set('inicio');
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
   *  detalle; aquí sólo caben los que mueven la aguja. */
  readonly topSkus = computed(() => (this.resultado()?.por_sku_tienda ?? []).slice(0, 6));

  private readonly ventaMayor = computed(() =>
    Math.max(...this.topSkus().map((s) => s.venta_perdida), 1),
  );

  anchoSku(venta: number): string {
    return `${Math.max((venta / this.ventaMayor()) * 100, 2)}%`;
  }

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
