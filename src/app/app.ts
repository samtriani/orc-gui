import { DecimalPipe, PercentPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { Analisis, Orcmm } from './orcmm';

type Paso = 'inicio' | 'trabajando' | 'bloqueado' | 'listo' | 'sin-datos' | 'error';

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

  fuentesVacias = computed(() => (this.resultado()?.fuentes ?? []).filter((f) => f.filas === 0));
}
