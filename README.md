# BUK Calendar Sync

Sincroniza automáticamente el calendario de BUK con Google Calendar usando GitHub Actions.

## Arquitectura

```
GitHub Actions → Puppeteer (scraping) → ICS file → GitHub Pages → Google Calendar
```

## Configuración

### 1. GitHub Secrets

En **Settings → Secrets and variables → Actions**, agregar:

- `BUK_EMAIL`: Tu email de BUK
- `BUK_PASSWORD`: Tu contraseña de BUK

### 2. GitHub Pages

En **Settings → Pages**:

- Source: `Deploy from a branch`
- Branch: `main`
- Folder: `/public`

### 3. Suscribir Google Calendar

1. Abre [Google Calendar](https://calendar.google.com)
2. Click en **+** junto a "Otros calendarios"
3. Selecciona **Desde URL**
4. Pega: `https://[tu-usuario].github.io/buk-calendar-sync/calendar.ics`
5. Click en **Añadir calendario**

Google actualizará el calendario cada 12-24 horas automáticamente.

## Ejecución Manual

Para ejecutar manualmente el workflow:

1. Ve a **Actions** en tu repositorio
2. Selecciona **Sync BUK Calendar**
3. Click en **Run workflow**

## Desarrollo Local

```bash
# Instalar dependencias
npm install

# Ejecutar (requiere variables de entorno)
BUK_EMAIL=tu@email.com BUK_PASSWORD=tu_password npm run sync
```

## Notas

- El workflow se ejecuta diariamente a las 6:00 AM hora de Chile (9:00 UTC)
- El scraper extrae eventos de los próximos 3 meses
- Si el scraper falla, genera un calendario vacío para no romper la suscripción
