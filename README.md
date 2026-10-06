# Control de Horas (PWA)

App web instalable para marcar **entrada y salida** con un botón o escaneando el **código de barras de tu credencial**, y ver por semana cuántas horas hiciste cada día y cuántas fueron:

| Concepto | Regla por defecto (Código del Trabajo, Ecuador) |
|---|---|
| **Ordinarias** | Primeras 8 h del turno |
| **Nocturnas 25%** | Horas ordinarias entre 19:00 y 06:00 (recargo del 25%) |
| **Suplementarias 50%** | Después de las 8 h, hasta las 24:00 |
| **Extraordinarias 100%** | Después de las 8 h entre 00:00 y 06:00, y **todo** lo trabajado en sábado, domingo o feriado |

Todo es configurable en **Ajustes**. Los datos se guardan **solo en tu teléfono** (localStorage): sin Firebase, sin servidor, sin cuenta.

## Cómo se calculan tus turnos habituales

| Turno | Descanso | Trabajadas | Ord. | Noct. 25% | Supl. 50% | Extra 100% |
|---|---|---|---|---|---|---|
| 08:00 – 17:00 | 60 min | 8 h | 8 h | 0 | 0 | 0 |
| 18:00 – 02:00 | 0 | 8 h | 8 h | 7 h | 0 | 0 |
| 06:00 – 18:00 | 60 min | 11 h | 8 h | 0 | 3 h | 0 |
| 06:00 – 19:00 | 60 min | 12 h | 8 h | 0 | 4 h | 0 |
| 17:00 – 03:00 | 0 | 10 h | 8 h | 6 h | 0 | 2 h |
| 17:00 – 04:00 | 0 | 11 h | 8 h | 6 h | 0 | 3 h |
| Sábado 08:00 – 17:00 | 60 min | 8 h | 0 | 0 | 0 | 8 h |

- El almuerzo de 60 min se descuenta solo en turnos de **más de 8,5 h que empiezan entre 04:00 y 13:59** (turno de día). Puedes cambiar la regla o el descuento de cada turno.
- Un turno que pasa la medianoche se cuenta en el **día en que empezó**.

## Rol de pagos estimado (pestaña **Rol**)

Calcula el mes con la misma lógica de tu rol:

| Rubro | Cálculo |
|---|---|
| Valor hora (VH) | Sueldo nominal ÷ 240 (o valor manual) |
| Sueldo ganado | Sueldo × días pagados ÷ 30 |
| Recargo nocturno 25% | h nocturnas × VH × 0,25 |
| Suplementarias 50% | h × VH × 1,5 |
| Extraordinarias 100% | h × VH × 2 |
| Alimentación | turnos con almuerzo × bono almuerzo + turnos con cena × bono cena |
| Anticipo quincena | 30% del sueldo ganado (o valor manual del mes) |
| Comedor | comidas marcadas "Consumí en comedor" × precio |
| Aporte IESS | 9,45% × (sueldo + recargo + suplementarias + extraordinarias) |

- Si entras entre 04:00 y 13:59 el turno cuenta como **almuerzo**; si no, como **cena**. Lo puedes cambiar en cada turno o en la tarjeta bajo el botón de marcar.
- Verificado con un rol real: VH 3,75; 22,68 h al 50%; 8,57 h al 100%; 5,57 h nocturnas → total a recibir 716,54.

## Publicarla en GitHub Pages (gratis)

1. Crea un repositorio nuevo en GitHub (por ejemplo `control-horas`), público.
2. Sube **todo el contenido** de esta carpeta (botón *Add file → Upload files*, arrastra los archivos y carpetas `icons/` y `vendor/`) y haz *Commit*.
3. Ve a **Settings → Pages**. En *Build and deployment* elige *Deploy from a branch*, rama `main`, carpeta `/ (root)` y guarda.
4. En 1–2 minutos tendrás la URL: `https://TU-USUARIO.github.io/control-horas/`.

> La cámara solo funciona por **https**, por eso hay que abrirla desde GitHub Pages (no abriendo el archivo directamente).

## Instalarla en el celular

- **Android (Chrome):** abre la URL → botón **Instalar app** arriba, o menú ⋮ → *Instalar aplicación*.
- **iPhone (Safari):** abre la URL → botón Compartir → *Agregar a pantalla de inicio*.

Después funciona **sin internet**.

## Marcar con la tarjeta

1. Ajustes → **Escanear para vincular** y apunta la cámara al código de barras de la credencial.
2. En la pantalla principal, **Marcar con tarjeta**: si no estás en turno marca entrada; si estás en turno marca salida.

- Usa el lector nativo de Chrome Android (`BarcodeDetector`) y, si no existe (iPhone), la librería ZXing incluida en `vendor/` (funciona offline).
- **NFC:** si tu teléfono es Android con Chrome, aparece el botón *Marcar con NFC* (Web NFC). Si tu credencial no tiene chip, simplemente no la detectará; usa el código de barras.

## Tus datos

- **Editar / corregir:** toca cualquier turno para cambiar horas, descanso o nota, o eliminarlo.
- **Turno olvidado:** Semana → *Agregar turno manual*.
- **Borrar:** un turno, una semana completa o todo (Ajustes → *Borrar todos los datos*).
- **Respaldo:** Ajustes → *Respaldar (JSON)* y *Restaurar*. Exporta CSV para Excel.
- Si borras los datos del navegador o desinstalas la app, se pierden: haz un respaldo de vez en cuando.

## Archivos

```
index.html            Interfaz
styles.css            Estilos (modo claro/oscuro)
app.js                Lógica: marcaciones, cálculo, escáner, exportación
sw.js                 Service worker (modo offline)
manifest.webmanifest  Datos de instalación de la PWA
icons/                Íconos de la app
vendor/zxing.min.js   Lector de códigos de barras (ZXing, Apache-2.0)
```

Si cambias algún archivo, sube el número en `const CACHE = 'control-horas-v1'` de `sw.js` para que los teléfonos tomen la nueva versión.

*Los montos y reglas son una referencia para tu control personal; confirma los criterios exactos con RR. HH. de tu empresa.*
