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
  readonly archivo = signal<File | null>(null);
  readonly resultado = signal<Analisis | null>(null);
  readonly error = signal<string | null>(null);
  readonly arrastrando = signal(false);
  readonly verDetalle = signal(false);

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
    this.tomar(input.files?.[0] ?? null);
  }

  soltar(evento: DragEvent): void {
    evento.preventDefault();
    this.arrastrando.set(false);
    this.tomar(evento.dataTransfer?.files?.[0] ?? null);
  }

  sobrevolar(evento: DragEvent, dentro: boolean): void {
    evento.preventDefault();
    this.arrastrando.set(dentro);
  }

  private tomar(archivo: File | null): void {
    if (!archivo) return;
    if (!archivo.name.toLowerCase().endsWith('.xlsx')) {
      this.error.set('El archivo tiene que ser el .xlsx de captura ORCMM.');
      this.paso.set('error');
      return;
    }
    this.archivo.set(archivo);
    this.error.set(null);
    this.analizar(false);
  }

  // -- análisis ------------------------------------------------------------

  analizar(corregir: boolean): void {
    const archivo = this.archivo();
    if (!archivo) return;

    this.paso.set('trabajando');
    this.error.set(null);

    this.api.analizar(archivo, corregir).subscribe({
      next: (r) => {
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
    this.archivo.set(null);
    this.resultado.set(null);
    this.error.set(null);
    this.verDetalle.set(false);
    this.paso.set('inicio');
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
