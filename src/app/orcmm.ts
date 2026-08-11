/**
 * Contrato con el backend ORCMM.
 *
 * Los nombres de los campos son los mismos que devuelve api/servicio.py: si
 * allá cambia uno, aquí truena la compilación en vez de aparecer un hueco en
 * la pantalla.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, of, timer } from 'rxjs';
import { concatMap, exhaustMap, map, switchMap, takeWhile } from 'rxjs/operators';

export interface Validacion {
  /** Layout roto: el modelo leería mal. Bloquean. */
  errores: string[];
  /** El layout está bien, faltan renglones. No bloquean; sí acotan la conclusión. */
  faltan_datos: string[];
  advertencias: string[];
  ok: string[];
}

export interface Fuente {
  hoja: string;
  filas: number;
  desde: string | null;
  hasta: string | null;
  equipo: string;
  owner: string;
}

export interface Bloqueo {
  campo: string;
  dias: number;
  venta_perdida: number;
  a_quien: string;
}

export interface Cobertura {
  casos_totales: number;
  casos_clasificados: number;
  cobertura_casos_pct: number;
  venta_perdida_total: number;
  venta_perdida_clasificada: number;
  cobertura_venta_perdida_pct: number;

  /** Alcance = los días cuyo SKU sí está en el catálogo de la tienda.
   *  BOPS puede entregar SKU de divisiones que este análisis no cubre; esos
   *  días no son un dato faltante, son días que no le tocaba explicar. La
   *  portada encabeza con la cobertura del alcance y deja la global como
   *  contraste: una mide al modelo, la otra mide la extracción. */
  casos_fuera_de_alcance: number;
  venta_perdida_fuera_de_alcance: number;
  casos_en_alcance: number;
  cobertura_casos_alcance_pct: number;
  venta_perdida_en_alcance: number;
  cobertura_venta_perdida_alcance_pct: number;

  bloqueos: Bloqueo[];
}

/** Un escalón del waterfall: cuántos puntos de OSA quitó esa causa. */
export interface Escalon {
  root_cause_id: string;
  causa: string;
  responsable: string;
  dias: number;
  puntos_osa: number;
}

/** De 100% al OSA real, en puntos porcentuales.
 *
 *  Es un reparto distinto al del Pareto: éste reparte el GAP DE OSA y el
 *  Pareto reparte la VENTA PERDIDA. Un día con faltante pesa igual que
 *  cualquier otro para el OSA, valga lo que valga en pesos, así que los dos
 *  órdenes pueden no coincidir. */
export interface Waterfall {
  osa_teorico: number;
  osa_real: number | null;
  universo_filas: number;
  escalones: Escalon[];
}

/** El cumplimiento del proveedor agregado, para la cifra de portada. */
export interface FillRate {
  proveedores: number;
  pedidos: number;
  citas: number;
  pedidos_sin_cita: number;
  cajas_pedidas: number;
  cajas_confirmadas: number;
  cajas_entregadas: number;
  pct_efectivo: number | null;
  pct_cumplimiento: number | null;
  pct_confirmado: number | null;
}

export interface FilaCausa {
  root_cause_id: string;
  causa: string;
  dias: number;
  venta_perdida: number;
  pct: number;
  responsable: string;
}

export interface FilaResponsable {
  responsable: string;
  dias: number;
  venta_perdida: number;
  pct: number;
}

export interface FilaSubcausa {
  subcausa: string;
  dias: number;
  venta_perdida: number;
}

export interface FilaSkuTienda {
  sku: string;
  tienda: string;
  dias_con_faltante: number;
  dias_clasificados: number;
  cobertura_pct: number;
  venta_perdida: number;
  osa_promedio: number | null;
  root_cause_id: string;
  causa: string;
  responsable: string;
}

export interface FilaProveedor {
  proveedor_id: string;
  nombre: string;
  pedidos: number;
  cajas_pedidas: number;
  pct_surtido_pedido: number | null;
  citas: number;
  pedidos_sin_cita: number;
  cajas_pedidas_con_cita: number;
  cajas_confirmadas: number;
  cajas_entregadas: number;
  pct_confirmado: number | null;
  pct_cumplimiento: number | null;
  pct_efectivo: number | null;
  citas_incumplidas: number;
}

export interface CitaFallada {
  folio: string;
  folio_cita: string;
  sku: string;
  proveedor: string;
  fecha_cita: string | null;
  confirmadas: number;
  entregadas: number;
  faltantes: number;
  estatus: string;
}

export interface Correccion {
  cambios: string[];
  errores_que_siguen: string[];
}

/** Respuesta de /api/analizar/{id}. Los bloques del resumen sólo vienen con
 *  estado 'ok'; mientras corre, sólo llegan `estado` y `segundos`. */
export interface Analisis {
  id: string;
  archivo: string;
  estado: 'en_proceso' | 'ok' | 'bloqueado' | 'sin_datos';

  /** Sólo en 'en_proceso': cuánto lleva corriendo. */
  segundos?: number;

  // estado 'bloqueado'
  valido?: boolean;
  corregible?: boolean;
  cambios_propuestos?: string[];
  errores_tras_correccion?: string[];

  // estado 'sin_datos'
  motivo?: string;

  validacion: Validacion;
  correccion?: Correccion | null;
  /** OSA del periodo sobre los SKU que sí le tocan al análisis (los del
   *  catálogo de la tienda). Es el número de portada. */
  osa_alcance?: number | null;
  /** OSA sobre TODAS las filas de BOPS_OSA. Cuando el export trae divisiones
   *  fuera del alcance, este número se hunde por SKU que el catálogo ni
   *  conoce: mide la extracción, no la disponibilidad. */
  osa_general?: number | null;
  aviso_parcial?: string | null;
  advertencias?: string[];
  fuentes?: Fuente[];

  // estado 'ok'
  nombre_salida?: string;
  umbral_osa?: number;
  waterfall?: Waterfall;
  fill_rate_proveedor?: FillRate;
  cobertura?: Cobertura;
  por_causa?: FilaCausa[];
  por_responsable?: FilaResponsable[];
  por_subcausa?: FilaSubcausa[];
  por_sku_tienda?: FilaSkuTienda[];
  proveedores?: FilaProveedor[];
  citas_falladas?: CitaFallada[];
  discrepancias?: { folio: string; sku: string; motivos: string }[];
}

/** Lo que responde POST /api/analizar: sólo el acuse con el id. */
interface Encolado {
  id: string;
  archivo: string;
  estado: 'en_proceso';
}

/** Una fila de GET /api/tiendas — tiendas con datos ya cargados en Postgres. */
export interface Tienda {
  tienda: string;
  nombre: string | null;
  formato: string | null;
  /** Rango de fechas con datos, para acotar el selector de periodo. */
  fecha_min: string | null;
  fecha_max: string | null;
}

/** Un día del detalle diario de un SKU (GET /api/expediente). Los booleanos
 *  y `root_cause_id` vienen del mismo motor que clasifica el análisis
 *  completo — no es una aproximación aparte. `root_cause_id` es `null` en
 *  los días sin faltante (OSA 100%). */
export interface DiaExpediente {
  fecha: string;
  osa_pct: number | null;
  existencia_tienda: number | null;
  unidades_vendidas: number | null;
  existencia_cedis: number | null;
  pedido_tienda_abierto: boolean | null;
  transito_vigente: boolean | null;
  envio_generado: boolean | null;
  orden_proveedor_vigente: boolean | null;
  cajas_pedidas_proveedor: number | null;
  cajas_entregadas_proveedor: number | null;
  root_cause_id: string | null;
  causa_raiz: string | null;
  responsable: string | null;
}

/** Respuesta de GET /api/expediente. */
export interface Expediente {
  sku: string;
  tienda: string;
  descripcion: string | null;
  desde: string;
  hasta: string;
  dias: DiaExpediente[];
}

/** Cada cuánto se le pregunta al backend si ya terminó. El análisis del layout
 *  completo tarda un par de minutos, así que preguntar más seguido sólo suma
 *  peticiones sin adelantar nada. */
const ESPERA_MS = 3000;

@Injectable({ providedIn: 'root' })
export class Orcmm {
  private readonly http = inject(HttpClient);
  private readonly base = '/api';

  /**
   * Sube el paquete y sigue el análisis hasta que termina.
   *
   * El backend no analiza dentro del request: con el volumen real la corrida
   * tarda minutos y un request abierto tanto tiempo se lo lleva cualquier
   * proxy de por medio. Responde un id y aquí se hace poll hasta que el
   * estado deja de ser 'en_proceso'. Para quien llama, sigue siendo un solo
   * Observable que emite el avance y termina con el resultado.
   *
   * `archivos` es el .xlsx del layout más los CSV de las hojas que ya no
   * caben en una hoja de Excel, o un .zip con todo dentro.
   *
   * El umbral de OSA no se expone en la pantalla: se queda en el 100 que trae
   * el backend por omisión, o sea todo día que no esté al 100% de
   * disponibilidad. Quien lo quiera mover, lo mueve por API o por CLI.
   */
  analizar(archivos: File[], corregir: boolean, forzar = false): Observable<Analisis> {
    const cuerpo = new FormData();
    for (const a of archivos) cuerpo.append('archivos', a, a.name);

    return this.http
      .post<Encolado>(`${this.base}/analizar`, cuerpo, { params: { corregir, forzar } })
      .pipe(switchMap((encolado) => this.seguir(encolado.id)));
  }

  /**
   * Sigue un análisis encolado hasta que termina: emite el avance mientras
   * corre y el resumen completo al final.
   *
   * Dos decisiones que importan, las dos aprendidas a golpes:
   *
   * `exhaustMap` y NO `switchMap` — mientras haya una petición viva, los ticks
   * nuevos se ignoran en vez de abortarla. Con `switchMap`, cualquier
   * respuesta más lenta que el intervalo se cancelaba en cada vuelta y la
   * pantalla se quedaba girando para siempre con el análisis ya terminado del
   * otro lado.
   *
   * El resumen se pide APARTE y una sola vez. `/analizar/{id}` devuelve unos
   * bytes de estado; el resumen del análisis real pesa ~1.5 MB y tarda 3.7 s
   * directo y 17-30 s por el proxy de Vercel. Arrastrarlo en cada vuelta del
   * poll era lo que hacía que ninguna respuesta cupiera en el intervalo.
   */
  private seguir(id: string): Observable<Analisis> {
    return timer(0, ESPERA_MS).pipe(
      exhaustMap(() => this.http.get<Analisis>(`${this.base}/analizar/${id}`)),
      takeWhile((e) => e.estado === 'en_proceso', true),
      concatMap((e) =>
        e.estado === 'en_proceso'
          ? of({ ...e, id })
          : this.http
              .get<Analisis>(`${this.base}/analizar/${id}/resumen`)
              // El id no viene en el cuerpo; se conserva el del acuse para
              // que la descarga lo tenga siempre.
              .pipe(map((resumen) => ({ ...resumen, id }))),
      ),
    );
  }

  urlDescarga(id: string): string {
    return `${this.base}/resultado/${id}`;
  }

  /** Tiendas con datos ya cargados en Postgres, para el selector de "elegir
   *  tienda y periodo" (alternativa a subir un archivo). */
  listarTiendas(): Observable<Tienda[]> {
    return this.http.get<{ tiendas: Tienda[] }>(`${this.base}/tiendas`).pipe(map((r) => r.tiendas));
  }

  /**
   * Igual que `analizar()`, pero en vez de subir un archivo, pide el
   * análisis para una tienda y un periodo que ya viven en Postgres. Mismo
   * acuse-y-poll: el backend encola en la misma cola de siempre y aquí se
   * sigue exactamente igual que un análisis por archivo.
   */
  analizarPorTienda(tienda: string, desde: string, hasta: string, umbralOsa = 100): Observable<Analisis> {
    const cuerpo = { tienda, desde, hasta, umbral_osa: umbralOsa };

    return this.http
      .post<Encolado>(`${this.base}/analizar-tienda`, cuerpo)
      .pipe(switchMap((encolado) => this.seguir(encolado.id)));
  }

  /** Detalle diario de un SKU en una tienda: inventario, venta, pedidos y la
   *  causa raíz de cada día. A diferencia de analizar()/analizarPorTienda(),
   *  no hace falta acuse-y-poll — un solo SKU responde directo. */
  expediente(tienda: string, sku: string, desde: string, hasta: string): Observable<Expediente> {
    const params = { tienda, sku, desde, hasta };
    return this.http.get<Expediente>(`${this.base}/expediente`, { params });
  }
}
