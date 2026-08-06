# ORCMM — Clasificación de desabasto (OSA) por causa raíz · front

Interfaz para subir el Excel de captura de La Comer, ver el diagnóstico de
causa raíz en pantalla y descargar el Excel de resultados.

El motor no vive aquí: este repo sólo sube el archivo y pinta lo que le
regresa el backend.

> **El backend está en [samtriani/orc-api](https://github.com/samtriani/orc-api).
> Sin él corriendo, esta aplicación no hace nada.**

## Correrlo

Hacen falta los dos procesos.

**1. Backend** — en el repo `orc-api`, escuchando en el 8000:

```bash
pip install -r requirements.txt
python -m uvicorn api.main:app --reload --port 8000
```

**2. Este front:**

```bash
npm install        # sólo la primera vez
npm start
```

Queda en `http://localhost:4200`. En desarrollo `/api` va por proxy al 8000
(`proxy.conf.json`), así que el navegador ve un solo origen y no hay CORS de
por medio.

Para compilar a producción: `npm run build`, que deja el bundle en `dist/web`.

### Versiones

Angular 20, fijado a propósito: el CLI más reciente pide Node ≥ 24.15 y la
máquina donde se armó tiene 24.13.1. Con Node ≥ 20.19 esto compila.

## El flujo

1. Se arrastra el `.xlsx` de captura. No hay más controles: el análisis arranca
   solo.
2. El backend valida el layout contra su especificación. Si hay errores, corre
   además el corrector automático sobre una copia y vuelve a validar, para
   saber si el arreglo sirve para *ese* archivo.
3. Según lo que encuentre:
   - **Layout bien** → analiza directo.
   - **Errores corregibles** → la pantalla ofrece **"Corregir y analizar"**, con
     el detalle de qué cambiaría. El archivo original nunca se modifica.
   - **Errores que no se pueden corregir solos** → se muestra el reporte para
     pedírselo al equipo dueño de la hoja.
4. Con el resultado se pintan: cobertura del modelo, Pareto por causa raíz y por
   responsable, cumplimiento del proveedor en CEDIS, qué falla del proveedor
   costó más, qué dato bloqueó la clasificación y a quién pedírselo, y el
   detalle por SKU-tienda. Más el botón para descargar el Excel de 5 hojas.

### Lo que la pantalla distingue y conviene no confundir

| | Qué es | ¿Bloquea? |
|---|---|---|
| **Errores de layout** | Columnas que no existen, claves capturadas como número. El modelo leería mal. | Sí |
| **Datos incompletos** | El layout está bien, faltan renglones (hoja vacía, citas parciales). | No: salen como cobertura perdida |
| **Advertencias** | Vale la pena revisarlo antes de firmar el Pareto. | No |

También hay un aviso rojo, imposible de saltarse, cuando el análisis corre
**parcial** — hoy la prioridad 3 está apagada mientras SIMA entrega los pedidos
de tienda, y eso hace que RC03 no pueda aparecer en el Pareto. El detalle está
en el README de `orc-api`.

## Estructura

| Archivo | Qué hace |
|---|---|
| `src/app/orcmm.ts` | El contrato con el backend: tipos y llamadas. Si allá cambia un campo, aquí truena la compilación en vez de aparecer un hueco en la pantalla. |
| `src/app/app.ts` | Estado de la pantalla y ayudas de presentación. |
| `src/app/app.html` | La vista, con los cuatro estados: carga, trabajando, bloqueado, resultado. |
| `src/app/app.css` | Estilos. Los colores de las causas son los mismos del Excel. |
| `proxy.conf.json` | Manda `/api` al backend en desarrollo. |
