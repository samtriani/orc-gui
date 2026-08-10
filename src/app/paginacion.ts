/**
 * Paginación para las tablas del resultado.
 *
 * El análisis real trae 496 SKU con gap, 829 proveedores y cientos de citas
 * falladas. Volcadas de corrido, la pantalla se vuelve un scroll infinito
 * donde no se puede buscar nada.
 *
 * El paginador NO guarda una copia de los datos: recibe la señal de la lista
 * ya filtrada y deriva la página. Así, cuando cambia un filtro, la página se
 * recalcula sola y nunca queda apuntando a un renglón que ya no existe.
 */
import { Component, Signal, computed, input, signal } from '@angular/core';

/** Cuántos renglones por página. El primero es el que se usa por omisión. */
export const TAMANOS = [20, 50, 100] as const;

export class Paginador<T> {
  readonly pagina = signal(1);
  readonly porPagina = signal<number>(TAMANOS[0]);

  readonly total: Signal<number>;
  readonly paginas: Signal<number>;
  /** La página válida de verdad. Si un filtro dejó la lista más corta que la
   *  página en la que estabas, se recorta aquí en vez de mostrar vacío. */
  readonly actual: Signal<number>;
  readonly items: Signal<T[]>;
  readonly desde: Signal<number>;
  readonly hasta: Signal<number>;

  constructor(fuente: Signal<T[]>) {
    this.total = computed(() => fuente().length);
    this.paginas = computed(() => Math.max(1, Math.ceil(this.total() / this.porPagina())));
    this.actual = computed(() => Math.min(this.pagina(), this.paginas()));
    this.desde = computed(() => (this.total() === 0 ? 0 : (this.actual() - 1) * this.porPagina() + 1));
    this.hasta = computed(() => Math.min(this.actual() * this.porPagina(), this.total()));
    this.items = computed(() => {
      const ini = (this.actual() - 1) * this.porPagina();
      return fuente().slice(ini, ini + this.porPagina());
    });
  }

  ir(p: number): void {
    this.pagina.set(Math.min(Math.max(1, p), this.paginas()));
  }

  cambiarTamano(n: number): void {
    this.porPagina.set(n);
    this.pagina.set(1);
  }

  reiniciar(): void {
    this.pagina.set(1);
  }
}

/**
 * Los controles. Se esconde solo cuando todo cabe en una página: un paginador
 * de "1 de 1" es ruido.
 */
@Component({
  selector: 'app-paginador',
  template: `
    @if (p().total() > tamanos[0]) {
      <div class="pager">
        <span class="pager-cuenta">
          {{ p().desde() }}–{{ p().hasta() }} de {{ p().total() }}
        </span>

        <span class="pager-botones">
          <button type="button" [disabled]="p().actual() === 1" (click)="p().ir(1)" title="Primera">
            «
          </button>
          <button
            type="button"
            [disabled]="p().actual() === 1"
            (click)="p().ir(p().actual() - 1)"
            title="Anterior"
          >
            ‹
          </button>
          <span class="pager-pos">{{ p().actual() }} / {{ p().paginas() }}</span>
          <button
            type="button"
            [disabled]="p().actual() === p().paginas()"
            (click)="p().ir(p().actual() + 1)"
            title="Siguiente"
          >
            ›
          </button>
          <button
            type="button"
            [disabled]="p().actual() === p().paginas()"
            (click)="p().ir(p().paginas())"
            title="Última"
          >
            »
          </button>
        </span>

        <label class="pager-tam">
          <select (change)="alCambiarTamano($event)">
            @for (t of tamanos; track t) {
              <option [value]="t" [selected]="t === p().porPagina()">{{ t }} por página</option>
            }
          </select>
        </label>
      </div>
    }
  `,
})
export class PaginadorCtrl {
  readonly p = input.required<Paginador<unknown>>();
  readonly tamanos = TAMANOS;

  alCambiarTamano(e: Event): void {
    this.p().cambiarTamano(Number((e.target as HTMLSelectElement).value));
  }
}
