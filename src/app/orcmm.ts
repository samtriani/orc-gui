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
  /** De CATALOGO — para poder buscar por nombre además de por código. */
  descripcion: string | null;
  /** Índice al catálogo `Analisis.jerarquia`: sección, categoría,
   *  subcategoría y marca. Es un índice y no los cuatro textos porque
   *  escribirlos en cada renglón pesaba 1.3 MB de más. */
  j: number;
  dias_con_faltante: number;
  dias_clasificados: number;
  cobertura_pct: number;
  venta_perdida: number;
  /**
   * NO usar: promedia el OSA sólo de los días con faltante, que valen 0 por
   * definición (BOPS reporta OSA binario). Da 0 en todos los renglones. Se
   * conserva porque el backend lo sigue mandando; el bueno es osa_periodo.
   */
  osa_promedio: number | null;
  /** Días del periodo con lectura de OSA para este SKU — el denominador. */
  dias_evaluados: number | null;
  /** OSA del SKU en TODO el periodo: días visibles / días evaluados. */
  osa_periodo: number | null;
  root_cause_id: string;
  causa: string;
  responsable: string;
}

/**
 * Lo que se dejó FUERA del análisis por no tener datos de SIMA.
 *
 * Estos SKU no están fuera de alcance de verdad: están en el catálogo,
 * activos, y su pedido a CEDIS sí debía existir. Se excluyen porque sin ese
 * dato la prioridad 3 no se puede contestar, y dejarlos dentro llenaba el
 * waterfall de una barra de "Sin clasificar" que no dice nada del negocio.
 *
 * El precio es que la cobertura se calcula sobre un universo más chico. Por
 * eso estas cifras NO son opcionales en pantalla: sin ellas, un "100% de
 * cobertura" y una venta perdida más baja mienten por omisión.
 */
export interface ExcluidosSinSima {
  skus: number;
  dias_con_faltante: number;
  venta_perdida: number;
  /** Sobre cuántos SKU del catálogo sí se analizó — el denominador honesto. */
  skus_en_alcance: number;
}

/** Nivel de servicio de CEDIS a tienda, en PIEZAS (SIMA no entrega cajas). */
export interface NivelServicioTienda {
  pedidos: number;
  piezas_pedidas: number;
  piezas_surtidas: number;
  pedidos_completos: number;
  pedidos_sin_surtir: number;
  nivel_servicio_pct: number | null;
}

export interface FilaProveedor {
  proveedor_id: string;
  /** Todos los IDs consolidados en este renglón (Nestlé venía con dos). */
  ids: string[];
  nombre: string;
  pedidos: number;
  cajas_pedidas: number;
  /** Cajas que COMPRAS reporta entregadas al cerrar el pedido. Viene en el
   *  100% de los pedidos, a diferencia de cajas_entregadas (de la cita). */
  cajas_surtidas: number;
  /** Cajas entregadas / cajas pedidas, ambas de COMPRAS. */
  nivel_servicio: number | null;
  /** Disponibilidad de los SKU de este proveedor. Descriptivo, no atributivo:
   *  un faltante por ejecución en tienda también lo baja. */
  osa_periodo: number | null;
  dias_evaluados: number | null;
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

/**
 * El detalle día por día, comprimido, para poder recalcular el waterfall y
 * los Pareto cuando el usuario filtra.
 *
 * Hace falta porque `por_sku_tienda` sólo trae la causa DOMINANTE de cada
 * SKU: uno con RC01 unos días y RC06 otros se ve ahí como "100% RC01", así
 * que recalcular desde esa tabla daría números equivocados.
 *
 * Viene comprimido — las causas en un catálogo aparte y cada día con su
 * índice — para no repetir los textos en ~5,200 renglones.
 */
export interface DetalleDias {
  /** `subcausa` va en el catálogo y no en cada día: son unas pocas
   *  combinaciones distintas contra decenas de miles de renglones. */
  causas: {
    root_cause_id: string;
    causa: string;
    responsable: string;
    subcausa: string | null;
  }[];
  /** s=sku · t=tienda · c=índice en `causas` · v=venta perdida. */
  dias: { s: string; t: string; c: number; v: number }[];
  /** Filas de BOPS del alcance por SKU-tienda: el denominador del waterfall,
   *  desglosado para poder recomponerlo al filtrar.
   *
   *  Trae `j` —índice en `Analisis.jerarquia`— y los días no, porque esta
   *  lista sí puede incluir SKU que nunca tuvieron un faltante y por lo
   *  tanto no aparecen en `por_sku_tienda`. Sin el índice, al filtrar por
   *  categoría esos se caerían del denominador y el OSA saldría hundido. */
  universo: { s: string; t: string; n: number; j: number }[];
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
  estado: 'en_proceso' | 'ok' | 'bloqueado' | 'sin_datos' | 'cancelado';

  /** Sólo en 'en_proceso'. 'en_cola' es esperar turno —el servidor corre un
   *  análisis a la vez— y no es lo mismo que estar trabajando. */
  fase?: 'en_cola' | 'corriendo';
  /** Sólo en 'en_proceso': segundos EN LA FASE actual, no desde que se pidió. */
  segundos?: number;
  /** Sólo mientras corre: en qué va — "leyendo catálogo", "clasificando por
   *  causa raíz", "generando el Excel". Sin esto la pantalla dice lo mismo
   *  durante minutos y no hay forma de saber si avanza o se atoró. */
  etapa?: string;
  /** Sólo en 'en_cola': cuántos hay formados adelante. */
  delante?: number;

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
  nivel_servicio_tienda?: NivelServicioTienda;
  excluidos_sin_sima?: ExcluidosSinSima;
  cobertura?: Cobertura;
  por_causa?: FilaCausa[];
  por_responsable?: FilaResponsable[];
  por_subcausa?: FilaSubcausa[];
  por_sku_tienda?: FilaSkuTienda[];
  detalle_dias?: DetalleDias;
  /** Catálogo de las combinaciones distintas de jerarquía comercial, en el
   *  orden [sección, categoría, subcategoría, marca]. Lo indexa la `j` de
   *  cada SKU y de cada renglón del universo. Llega vacío —o con un solo
   *  combo de nulos— si el análisis corrió sin catálogo comercial. */
  jerarquia?: (string | null)[][];

  /** Sólo cuando el resumen se leyó del histórico. Sirve para que la pantalla
   *  diga que esto no se acaba de calcular, y con qué versión del motor se
   *  hizo — un resultado de hace un mes puede no coincidir con lo que daría
   *  el motor de hoy. */
  guardado?: {
    tienda: string;
    desde: string;
    hasta: string;
    version_motor: string | null;
    corrido_en: string;
  };
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
/**
 * Un análisis ya corrido y guardado.
 *
 * Es el renglón de la pantalla inicial, sin el resumen: ése pesa ~5 MB y aquí
 * sólo se pintan las cifras de portada. El detalle se pide aparte al abrirlo.
 */
export interface Corrida {
  id: string;
  tienda: string;
  desde: string;
  hasta: string;
  umbral_osa: number;
  /** El commit del motor que la produjo. Dos corridas del mismo periodo con
   *  versiones distintas NO son comparables: las reglas cambian. */
  version_motor: string | null;
  osa_alcance: number | null;
  dias_faltante: number | null;
  venta_perdida: number | null;
  cobertura_pct: number | null;
  corrido_en: string;
  segundos: number | null;
  origen: string;
  archivo: string | null;
}

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

  /** Engancha con un análisis que ya viene corriendo, sin encolar otro. Es lo
   *  que se ofrece cuando el backend responde 409 porque ya hay uno en vuelo. */
  seguirExistente(id: string): Observable<Analisis> {
    return this.seguir(id);
  }

  cancelar(id: string): Observable<{ libero_el_turno: boolean; detalle: string }> {
    return this.http.delete<{ libero_el_turno: boolean; detalle: string }>(
      `${this.base}/analizar/${id}`,
    );
  }

  /** Las corridas ya hechas, lo más reciente primero. Sin el resumen. */
  listarCorridas(limite = 50): Observable<Corrida[]> {
    return this.http
      .get<{ runs: Corrida[] }>(`${this.base}/runs`, { params: { limite } })
      .pipe(map((r) => r.runs));
  }

  /** El resumen guardado de una corrida, listo para pintar. Mismo cuerpo que
   *  el de un análisis recién hecho, más el bloque `guardado`. */
  leerCorrida(id: string): Observable<Analisis> {
    return this.http.get<Analisis>(`${this.base}/runs/${id}`);
  }

  borrarCorrida(id: string): Observable<unknown> {
    return this.http.delete(`${this.base}/runs/${id}`);
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
