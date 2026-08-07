# ORCMM — Clasificación de desabasto (OSA) por causa raíz · front

Interfaz para subir la captura de La Comer, ver el diagnóstico de causa raíz
en pantalla y descargar el Excel de resultados.

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

1. Se arrastra **la captura completa**: el `.xlsx` del layout junto con los
   `.csv` de Tableau, o un `.zip` con todo dentro. Desde el layout V5 dos hojas
   pasan del millón de filas que aguanta una hoja de Excel y se entregan
   aparte. El zip es lo recomendable: esos CSV pesan más de 200 MB sueltos y
   menos de 40 comprimidos. No hay más controles, el análisis arranca solo.
2. El backend valida el paquete contra su especificación, y de paso cruza las
   fuentes entre sí. Si hay errores **de formato**, corre además el corrector
   automático sobre una copia y vuelve a validar, para saber si el arreglo
   sirve para *ese* archivo.
3. Según lo que encuentre:
   - **Layout bien** → analiza directo.
   - **Errores corregibles** → la pantalla ofrece **"Corregir y analizar"**, con
     el detalle de qué cambiaría. El archivo original nunca se modifica.
   - **Errores que no se pueden corregir solos** → se muestra el reporte, y con
     **"Analizar de todos modos"** se puede correr igual. Sirve cuando lo roto
     es una hoja de la que depende sólo una parte del reporte: una extracción
     de citas incompleta afecta al cumplimiento del proveedor, no al Pareto por
     causa raíz.
4. **El análisis es asíncrono.** Con el volumen real son millones de filas y la
   corrida tarda un par de minutos, así que el backend responde un id y la
   pantalla hace poll mostrando cuánto lleva. Un request abierto tanto tiempo
   se lo llevaría cualquier proxy de por medio.
5. Con el resultado, la pantalla va **de lo general a lo particular**:
   - **Portada** — las cifras del periodo, el waterfall de *dónde se pierde la
     disponibilidad* (cuántos puntos de OSA quitó cada causa) y los SKU que más
     costaron.
   - **Detalle** — Pareto por causa raíz y por responsable, cumplimiento del
     proveedor en CEDIS, qué detalle de la causa costó más.
   - **Auditoría** — qué dato bloqueó la clasificación y a quién pedírselo, el
     desglose por SKU-tienda, las fuentes leídas y las advertencias.

   Más el botón para descargar el Excel de 5 hojas.

### Dos OSA y dos coberturas

BOPS puede entregar SKU que el catálogo de la tienda no reconoce — divisiones
que este análisis no cubre. Esos días no son un dato faltante: son días que al
modelo **no le tocaba explicar**, y contarlos como fallas hunde las cifras.

Por eso la portada encabeza con el **alcance** (los SKU del catálogo) y deja el
número global como contraste, con un aviso que dice cuántos días quedaron
fuera. Uno mide la disponibilidad; el otro mide qué tan bien filtrada vino la
extracción.

### El waterfall no es el Pareto

Reparten cosas distintas y el orden puede no coincidir:

- el **waterfall** reparte el *gap de OSA* — un día con faltante pesa igual que
  cualquier otro, valga lo que valga;
- el **Pareto** reparte la *venta perdida*.

### Lo que la pantalla distingue y conviene no confundir

| | Qué es | ¿Bloquea? |
|---|---|---|
| **Errores de layout** | Columnas que no existen, obligatorios vacíos, claves deformadas al capturarse, hojas que no cuadran entre sí. El modelo leería mal. | Sí, salvo "Analizar de todos modos" |
| **Datos incompletos** | El layout está bien, faltan renglones (hoja vacía, citas parciales, fuentes que no cruzan). | No: salen como cobertura perdida |
| **Advertencias** | Vale la pena revisarlo antes de firmar el Pareto. | No |

También hay un aviso rojo, imposible de saltarse, cuando el análisis corre
**parcial** — hoy la prioridad 3 está apagada mientras SIMA entrega los pedidos
de tienda, y eso hace que RC03 no pueda aparecer en el Pareto. El detalle está
en el README de `orc-api`.

## Estructura

| Archivo | Qué hace |
|---|---|
| `src/app/orcmm.ts` | El contrato con el backend: tipos, subida del paquete y el poll del análisis. Si allá cambia un campo, aquí truena la compilación en vez de aparecer un hueco en la pantalla. |
| `src/app/app.ts` | Estado de la pantalla y ayudas de presentación. |
| `src/app/app.html` | La vista, con los cuatro estados: carga, trabajando, bloqueado, resultado. |
| `src/app/app.css` | Estilos. Los colores de las causas son los mismos del Excel. |
| `proxy.conf.json` | Manda `/api` al backend en desarrollo. |
