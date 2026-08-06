/**
 * Contrato con el backend ORCMM.
 *
 * Los nombres de los campos son los mismos que devuelve api/servicio.py: si
 * allá cambia uno, aquí truena la compilación en vez de aparecer un hueco en
 * la pantalla.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

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
  bloqueos: Bloqueo[];
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

/** Respuesta de /api/analizar. Los bloques del resumen sólo vienen con estado 'ok'. */
export interface Analisis {
  id: string;
  archivo: string;
  estado: 'ok' | 'bloqueado' | 'sin_datos';

  // estado 'bloqueado'
  valido?: boolean;
  corregible?: boolean;
  cambios_propuestos?: string[];
  errores_tras_correccion?: string[];

  // estado 'sin_datos'
  motivo?: string;

  validacion: Validacion;
  correccion?: Correccion | null;
  /** % de OSA real del periodo: sobre TODAS las filas de BOPS_OSA, no sólo
   *  los días con faltante. Es la foto general antes de entrar a la causa
   *  raíz de cada día. Viene en estado 'ok' y 'sin_datos'. */
  osa_general?: number | null;
  aviso_parcial?: string | null;
  advertencias?: string[];
  fuentes?: Fuente[];

  // estado 'ok'
  nombre_salida?: string;
  umbral_osa?: number;
  cobertura?: Cobertura;
  por_causa?: FilaCausa[];
  por_responsable?: FilaResponsable[];
  por_subcausa?: FilaSubcausa[];
  por_sku_tienda?: FilaSkuTienda[];
  proveedores?: FilaProveedor[];
  citas_falladas?: CitaFallada[];
  discrepancias?: { folio: string; sku: string; motivos: string }[];
}

@Injectable({ providedIn: 'root' })
export class Orcmm {
  private readonly http = inject(HttpClient);
  private readonly base = '/api';

  /** El umbral de OSA no se expone en la pantalla: se queda en el 100 que trae
   *  el backend por omisión, o sea todo día que no esté al 100% de
   *  disponibilidad. Quien lo quiera mover, lo mueve por API o por CLI. */
  analizar(archivo: File, corregir: boolean): Observable<Analisis> {
    const cuerpo = new FormData();
    cuerpo.append('archivo', archivo, archivo.name);
    return this.http.post<Analisis>(`${this.base}/analizar`, cuerpo, {
      params: { corregir },
    });
  }

  urlDescarga(id: string): string {
    return `${this.base}/resultado/${id}`;
  }
}
