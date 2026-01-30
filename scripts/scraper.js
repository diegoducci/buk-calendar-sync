import puppeteer from 'puppeteer';
import { generateICS } from './generate-ics.js';

const BUK_URL = 'https://costasur.buk.cl';
const BUK_EMAIL = process.env.BUK_EMAIL;
const BUK_PASSWORD = process.env.BUK_PASSWORD;

if (!BUK_EMAIL || !BUK_PASSWORD) {
  console.error('Error: BUK_EMAIL and BUK_PASSWORD environment variables are required');
  process.exit(1);
}

/**
 * Parse a date string in various formats:
 * - ISO format: YYYY-MM-DD (from FullCalendar data-date attributes)
 * - DD/MM/YYYY or DD-MM-YYYY (from text content)
 */
function parseDate(dateStr) {
  if (!dateStr) return new Date(NaN);

  const parts = dateStr.split(/[/-]/).map(Number);

  // Check if it's ISO format (YYYY-MM-DD) - first part is 4 digits and > 1900
  if (parts[0] > 1900 && parts.length === 3) {
    // ISO format: YYYY-MM-DD
    const [year, month, day] = parts;
    return new Date(year, month - 1, day);
  }

  // Otherwise assume DD-MM-YYYY or DD/MM/YYYY
  const [day, month, year] = parts;
  const fullYear = year < 100 ? 2000 + year : year;
  return new Date(fullYear, month - 1, day);
}

/**
 * Add days to a date
 */
function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

async function login(page) {
  console.log('Navigating to BUK login...');
  await page.goto(BUK_URL, { waitUntil: 'networkidle0' });

  // Wait for login form
  await page.waitForSelector('input[type="email"], input[name="email"], #email, input[placeholder*="mail"]', { timeout: 10000 });

  // Try different selectors for email field
  const emailSelector = await page.evaluate(() => {
    const selectors = ['input[type="email"]', 'input[name="email"]', '#email', 'input[placeholder*="mail"]'];
    for (const sel of selectors) {
      if (document.querySelector(sel)) return sel;
    }
    return null;
  });

  if (!emailSelector) {
    throw new Error('Could not find email input field');
  }

  console.log('Entering email...');
  await page.type(emailSelector, BUK_EMAIL);

  // Check if password field is already visible (single-step login)
  let passwordSelector = await page.evaluate(() => {
    const selectors = ['input[type="password"]', 'input[name="password"]', '#password'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return sel; // Check if visible
    }
    return null;
  });

  // If no password field, this might be a multi-step login - click continue/next
  if (!passwordSelector) {
    console.log('Password field not visible, trying multi-step login...');

    // Click the continue/next button
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
      const continueBtn = buttons.find(btn => {
        const text = btn.textContent?.toLowerCase() || '';
        return text.includes('continuar') || text.includes('continue') ||
               text.includes('siguiente') || text.includes('next') ||
               text.includes('iniciar') || text.includes('entrar') ||
               btn.getAttribute('type') === 'submit';
      });
      if (continueBtn) {
        continueBtn.click();
        return true;
      }
      return false;
    });

    if (clicked) {
      // Wait for password field to appear
      try {
        await page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 });
        console.log('Password field appeared after clicking continue');
      } catch (e) {
        // Maybe navigation happened, wait for it
        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
        await page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 });
      }
    } else {
      // Try pressing Enter
      await page.keyboard.press('Enter');
      await page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 });
    }

    // Get password selector again
    passwordSelector = await page.evaluate(() => {
      const selectors = ['input[type="password"]', 'input[name="password"]', '#password'];
      for (const sel of selectors) {
        if (document.querySelector(sel)) return sel;
      }
      return null;
    });
  }

  if (!passwordSelector) {
    // Take a screenshot for debugging
    await page.screenshot({ path: 'debug-screenshot.png' });
    throw new Error('Could not find password input field after multi-step attempt');
  }

  console.log('Entering password...');
  await page.type(passwordSelector, BUK_PASSWORD);

  // Find and click submit button
  console.log('Submitting login...');

  // Wait a moment for any JavaScript validation
  await new Promise(r => setTimeout(r, 500));

  const submitClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"], button'));
    const loginButton = buttons.find(btn => {
      const text = btn.textContent?.toLowerCase() || '';
      return text.includes('iniciar') || text.includes('login') ||
             text.includes('entrar') || text.includes('acceder') ||
             btn.getAttribute('type') === 'submit';
    });
    if (loginButton) {
      loginButton.click();
      return true;
    }
    return false;
  });

  if (submitClicked) {
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 });
  } else {
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 });
  }

  console.log('Login successful');
}

async function navigateToCalendar(page) {
  console.log('Navigating to vacation calendar...');

  // Wait for page to be fully loaded after login
  await new Promise(r => setTimeout(r, 2000));

  // Log current URL for debugging
  console.log('Current URL after login:', page.url());

  // Look for calendar/vacaciones links using JavaScript click (more reliable)
  const calendarKeywords = ['calendar', 'vacaciones', 'ausencias', 'time_off', 'leave', 'licencia', 'permiso'];

  const clicked = await page.evaluate((keywords) => {
    const links = Array.from(document.querySelectorAll('a'));
    for (const link of links) {
      const href = (link.href || '').toLowerCase();
      const text = (link.textContent || '').toLowerCase();

      for (const keyword of keywords) {
        if (href.includes(keyword) || text.includes(keyword)) {
          console.log('Found calendar link:', link.href, link.textContent);
          link.click();
          return { found: true, href: link.href, text: link.textContent?.trim() };
        }
      }
    }

    // Try finding in sidebar/menu
    const menuItems = document.querySelectorAll('nav a, .sidebar a, .menu a, [role="menu"] a, [class*="nav"] a');
    for (const item of menuItems) {
      const text = (item.textContent || '').toLowerCase();
      for (const keyword of keywords) {
        if (text.includes(keyword)) {
          item.click();
          return { found: true, href: item.href, text: item.textContent?.trim() };
        }
      }
    }

    return { found: false };
  }, calendarKeywords);

  if (clicked.found) {
    console.log(`Found and clicked: ${clicked.text} (${clicked.href})`);
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 });
    } catch (e) {
      // Navigation might have already completed or not been needed
      console.log('Navigation wait finished (may have already completed)');
    }
    return;
  }

  // Try direct URL navigation if we know the pattern
  const baseUrl = page.url().split('/').slice(0, 3).join('/');
  const calendarUrls = [
    '/calendar',
    '/vacaciones',
    '/ausencias',
    '/time-off',
    '/leave',
    '/mis-vacaciones',
    '/employee/calendar',
    '/employee/vacaciones'
  ];

  for (const path of calendarUrls) {
    try {
      console.log(`Trying URL: ${baseUrl}${path}`);
      const response = await page.goto(`${baseUrl}${path}`, {
        waitUntil: 'networkidle0',
        timeout: 5000
      });
      if (response && response.status() === 200) {
        console.log(`Successfully navigated to ${path}`);
        return;
      }
    } catch (e) {
      // Continue to next URL
    }
  }

  console.log('Could not find calendar link, continuing on current page...');
  console.log('Page URL:', page.url());
}

/**
 * Clean event title by removing day numbers and extra whitespace
 */
function cleanTitle(title) {
  if (!title) return '';
  // Remove leading numbers (day numbers that get concatenated)
  // Pattern: one or two digits at the start, possibly followed by more text
  let cleaned = title.replace(/^\d{1,2}(?=\D)/, '').trim();
  // Also handle cases where multiple names might be concatenated
  // This is harder to fix automatically, but at least clean up whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

/**
 * Deduplicate events - only merge if they overlap or are adjacent (within 1 day)
 * Keep separate events that are not contiguous
 */
function deduplicateEvents(events) {
  // Group events by title
  const eventsByTitle = new Map();

  for (const event of events) {
    const key = event.title.toLowerCase();
    if (!eventsByTitle.has(key)) {
      eventsByTitle.set(key, []);
    }
    eventsByTitle.get(key).push({ ...event });
  }

  const result = [];

  for (const [title, titleEvents] of eventsByTitle) {
    // Sort events by start date
    titleEvents.sort((a, b) => a.startDate - b.startDate);

    // Merge overlapping or adjacent events (within 1 day gap)
    const merged = [];
    for (const event of titleEvents) {
      if (merged.length === 0) {
        merged.push(event);
        continue;
      }

      const last = merged[merged.length - 1];
      const gap = (event.startDate - last.endDate) / (1000 * 60 * 60 * 24); // days

      // Merge if overlapping or adjacent (gap <= 1 day)
      if (gap <= 1) {
        // Extend the last event
        if (event.endDate > last.endDate) {
          last.endDate = event.endDate;
        }
      } else {
        // Keep as separate event
        merged.push(event);
      }
    }

    result.push(...merged);
  }

  return result;
}

async function extractEvents(page) {
  console.log('Extracting calendar events...');

  // Log current URL for debugging
  console.log('Calendar page URL:', page.url());

  // Wait for calendar content to load
  await new Promise(r => setTimeout(r, 3000));

  // Debug: Log page structure
  const pageInfo = await page.evaluate(() => {
    return {
      title: document.title,
      bodyClasses: document.body.className,
      mainContent: document.querySelector('main, .main, #main, [role="main"]')?.innerHTML?.substring(0, 500) || 'No main found',
      allClasses: [...new Set([...document.querySelectorAll('*')].map(el => el.className).filter(c => c))].slice(0, 50)
    };
  });
  console.log('Page title:', pageInfo.title);
  console.log('Some page classes:', pageInfo.allClasses.slice(0, 20).join(', '));

  // Strategy 1: Try to access FullCalendar's JavaScript API directly
  console.log('Attempting to access FullCalendar API...');
  const fullCalendarEvents = await page.evaluate(() => {
    try {
      // FullCalendar v5+ stores the calendar instance on the element
      const calendarEl = document.querySelector('.fc, [class*="fullcalendar"], #calendar, [id*="calendar"]');
      if (!calendarEl) {
        console.log('No calendar element found');
        return null;
      }

      // Try to get FullCalendar instance (v5+)
      // The calendar object is usually stored in __fullCalendar or _calendar
      let calendarApi = null;

      // Check for FullCalendar v5+ API
      if (calendarEl.__fullCalendar) {
        calendarApi = calendarEl.__fullCalendar;
      } else if (calendarEl._calendar) {
        calendarApi = calendarEl._calendar;
      } else if (window.calendar) {
        calendarApi = window.calendar;
      }

      // Try to find it via jQuery if available (FullCalendar v3/v4)
      if (!calendarApi && window.jQuery) {
        const $cal = window.jQuery(calendarEl);
        if ($cal.fullCalendar) {
          // v3 API
          const events = $cal.fullCalendar('clientEvents');
          if (events && events.length > 0) {
            return events.map(e => ({
              title: e.title,
              start: e.start?.format?.() || e.start?.toISOString?.() || e.start,
              end: e.end?.format?.() || e.end?.toISOString?.() || e.end,
              allDay: e.allDay
            }));
          }
        }
      }

      if (calendarApi && typeof calendarApi.getEvents === 'function') {
        const events = calendarApi.getEvents();
        return events.map(e => ({
          title: e.title,
          start: e.start?.toISOString?.() || e.startStr,
          end: e.end?.toISOString?.() || e.endStr,
          allDay: e.allDay
        }));
      }

      // Try to find calendar data in global scope
      if (window.__CALENDAR_EVENTS__) {
        return window.__CALENDAR_EVENTS__;
      }

      return null;
    } catch (err) {
      console.log('Error accessing FullCalendar API:', err.message);
      return null;
    }
  });

  if (fullCalendarEvents && fullCalendarEvents.length > 0) {
    console.log(`Found ${fullCalendarEvents.length} events via FullCalendar API`);
    const processedEvents = fullCalendarEvents
      .filter(e => e.title)
      .map(event => {
        const startDate = event.start ? new Date(event.start) : new Date(NaN);
        // FullCalendar end dates are exclusive, so use them directly
        // If no end date, default to next day for all-day events
        let endDate = event.end ? new Date(event.end) : addDays(startDate, 1);

        return {
          title: cleanTitle(event.title),
          startDate,
          endDate,
          allDay: event.allDay !== false,
          description: 'Imported from BUK (FullCalendar API)'
        };
      })
      .filter(e => !isNaN(e.startDate.getTime()));

    console.log(`Processed ${processedEvents.length} valid events from FullCalendar API`);
    if (processedEvents.length > 0) {
      return deduplicateEvents(processedEvents);
    }
  }

  // Strategy 2: DOM-based extraction (fallback)
  console.log('Falling back to DOM-based extraction...');
  const events = await page.evaluate(() => {
    const extractedEvents = [];
    const debug = [];

    // Look for FullCalendar event elements
    // FullCalendar v5 uses fc-event class with data attributes
    const fcEvents = document.querySelectorAll('.fc-event, .fc-daygrid-event, .fc-timegrid-event');
    debug.push(`FullCalendar event elements: ${fcEvents.length}`);

    fcEvents.forEach(el => {
      // Get the event title - it's usually in a child element
      const titleEl = el.querySelector('.fc-event-title, .fc-title, .fc-event-title-container');
      let title = titleEl?.textContent?.trim() || el.textContent?.trim();

      // Skip if title looks like just a number (day number)
      if (!title || /^\d+$/.test(title)) return;

      // Try to get date from various sources
      // 1. From data attributes on the event itself
      let startStr = el.getAttribute('data-start') || el.getAttribute('data-date');
      let endStr = el.getAttribute('data-end');

      // 2. From the parent day cell
      if (!startStr) {
        const dayCell = el.closest('.fc-day, .fc-daygrid-day, [data-date]');
        startStr = dayCell?.getAttribute('data-date');
      }

      // 3. From the event's time element
      if (!startStr) {
        const timeEl = el.querySelector('time[datetime]');
        startStr = timeEl?.getAttribute('datetime');
      }

      if (title && title.length < 200) {
        extractedEvents.push({
          title,
          start: startStr,
          end: endStr,
          source: 'fc-event'
        });
      }
    });

    // Also look for events that span multiple days (they might have different markup)
    const multiDayEvents = document.querySelectorAll('.fc-event-resizable, [class*="fc-event"][class*="start"], [class*="fc-event"][class*="end"]');
    debug.push(`Multi-day event elements: ${multiDayEvents.length}`);

    multiDayEvents.forEach(el => {
      const titleEl = el.querySelector('.fc-event-title, .fc-title');
      const title = titleEl?.textContent?.trim() || el.textContent?.trim();

      if (!title || /^\d+$/.test(title)) return;

      // For multi-day events, we need to find the start and end dates
      const dayCell = el.closest('.fc-day, .fc-daygrid-day, [data-date]');
      const startStr = dayCell?.getAttribute('data-date');

      // Try to find the end date by looking at sibling events with same title
      // or by checking if there's an explicit end marker

      if (title && startStr) {
        extractedEvents.push({
          title,
          start: startStr,
          source: 'fc-multiday'
        });
      }
    });

    // BUK specific: Look for vacation/absence indicators in day cells
    const dayCells = document.querySelectorAll('.fc-day, .fc-daygrid-day, td[data-date]');
    debug.push(`Day cells: ${dayCells.length}`);

    dayCells.forEach(cell => {
      const date = cell.getAttribute('data-date');
      if (!date) return;

      // Look for content that indicates an event
      const eventIndicators = cell.querySelectorAll(
        '[class*="event"], [class*="vacation"], [class*="ausencia"], ' +
        '[class*="leave"], [class*="licencia"], [class*="permiso"], ' +
        '[class*="item"], .fc-event-title'
      );

      eventIndicators.forEach(indicator => {
        const title = indicator.textContent?.trim();
        // Skip day numbers and empty content
        if (title && !/^\d+$/.test(title) && title.length > 2 && title.length < 200) {
          extractedEvents.push({
            title,
            start: date,
            source: 'daycell-indicator'
          });
        }
      });
    });

    // Look for table-based vacation lists (common in BUK)
    const tableRows = document.querySelectorAll('table tbody tr, .table tr');
    debug.push(`Table rows: ${tableRows.length}`);

    tableRows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        // Try different cell patterns
        // Pattern 1: [Name] [Start Date] [End Date] [Type]
        // Pattern 2: [Date] [Name] [Type]

        let name = null;
        let startDate = null;
        let endDate = null;

        for (const cell of cells) {
          const text = cell.textContent?.trim();
          if (!text) continue;

          // Check if it looks like a date
          const dateMatch = text.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
          if (dateMatch) {
            if (!startDate) {
              startDate = text;
            } else if (!endDate) {
              endDate = text;
            }
          } else if (text.length > 3 && text.length < 100 && !name) {
            // Likely a name
            name = text;
          }
        }

        if (name && startDate) {
          extractedEvents.push({
            title: name,
            start: startDate,
            end: endDate,
            source: 'table'
          });
        }
      }
    });

    debug.push(`Total raw events: ${extractedEvents.length}`);
    return { events: extractedEvents, debug };
  });

  console.log('Extraction debug:', events.debug.join('; '));
  console.log(`Found ${events.events.length} raw events from DOM`);

  // Process and format events
  const rawEvents = events.events;
  const processedEvents = rawEvents
    .filter(e => e.start && e.title)
    .map(event => {
      const startDate = parseDate(event.start);
      // If we have an explicit end date, use it; otherwise default to next day
      let endDate = event.end ? parseDate(event.end) : addDays(startDate, 1);

      // If end date is same as start (or invalid), set to next day
      if (isNaN(endDate.getTime()) || endDate <= startDate) {
        endDate = addDays(startDate, 1);
      }

      return {
        title: cleanTitle(event.title),
        startDate,
        endDate,
        allDay: true,
        description: `Imported from BUK (${event.source})`
      };
    })
    .filter(e => !isNaN(e.startDate.getTime()));

  console.log(`Processed ${processedEvents.length} valid events`);

  // Deduplicate and merge events with same title and overlapping/adjacent dates
  return deduplicateEvents(processedEvents);
}

async function main() {
  console.log('Starting BUK calendar scraper...');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  let page;
  // Store intercepted calendar data
  const interceptedCalendarData = [];

  try {
    page = await browser.newPage();

    // Set viewport and user agent
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Set up response interception to capture calendar API data
    page.on('response', async (response) => {
      const url = response.url().toLowerCase();
      const contentType = response.headers()['content-type'] || '';

      // Look for calendar-related API endpoints
      if (
        (url.includes('calendar') || url.includes('event') ||
         url.includes('vacacion') || url.includes('ausencia') ||
         url.includes('leave') || url.includes('time_off') ||
         url.includes('holiday') || url.includes('feriado')) &&
        contentType.includes('application/json')
      ) {
        try {
          const json = await response.json();
          console.log(`Intercepted calendar data from: ${url}`);
          interceptedCalendarData.push({ url, data: json });
        } catch (e) {
          // Not JSON or couldn't parse - ignore
        }
      }
    });

    // Login to BUK
    await login(page);

    // Navigate to calendar section
    await navigateToCalendar(page);

    // Wait a bit for any async calendar data to load
    await new Promise(r => setTimeout(r, 2000));

    // Extract events, passing intercepted data
    const events = await extractEventsWithInterceptedData(page, interceptedCalendarData);

    if (events.length === 0) {
      console.log('No events found. Creating empty calendar...');
    }

    // Generate ICS file
    generateICS(events);

    console.log('Scraping completed successfully!');
  } catch (error) {
    console.error('Error during scraping:', error.message);
    console.error('Stack trace:', error.stack);

    // Try to capture current page state for debugging
    try {
      if (page) {
        const currentUrl = page.url();
        console.log('Current URL:', currentUrl);
        const pageTitle = await page.title();
        console.log('Page title:', pageTitle);
      }
    } catch (e) {
      console.log('Could not get page info');
    }

    // Generate empty calendar on error so the workflow doesn't fail completely
    console.log('Generating empty calendar due to error...');
    generateICS([]);

    process.exit(1);
  } finally {
    await browser.close();
  }
}

/**
 * Extract events using intercepted network data first, then fall back to DOM extraction
 */
async function extractEventsWithInterceptedData(page, interceptedData) {
  // Strategy 0: Try to use intercepted calendar API data first
  if (interceptedData.length > 0) {
    console.log(`Processing ${interceptedData.length} intercepted API responses...`);

    const apiEvents = [];

    for (const { url, data } of interceptedData) {
      console.log(`API URL: ${url}`);

      // Handle various API response formats
      let events = [];

      if (Array.isArray(data)) {
        events = data;
      } else if (data.events && Array.isArray(data.events)) {
        events = data.events;
      } else if (data.data && Array.isArray(data.data)) {
        events = data.data;
      } else if (data.results && Array.isArray(data.results)) {
        events = data.results;
      }

      console.log(`Raw events count: ${events.length}`);

      // Log first few raw events for debugging
      events.slice(0, 5).forEach((e, i) => {
        console.log(`Raw event ${i}: ${JSON.stringify(e).substring(0, 200)}`);
      });

      for (const event of events) {
        // Try to extract event data from various possible field names
        const title = event.title || event.name || event.nombre ||
                     event.employee_name || event.empleado ||
                     event.description || event.descripcion;

        const start = event.start || event.start_date || event.fecha_inicio ||
                     event.startDate || event.begin || event.inicio;

        const end = event.end || event.end_date || event.fecha_fin ||
                   event.endDate || event.finish || event.fin;

        if (title && start) {
          console.log(`Event: "${cleanTitle(title)}" | ${start} - ${end || 'no end'}`);
          apiEvents.push({
            title: cleanTitle(title),
            start,
            end,
            source: 'api-intercept'
          });
        }
      }
    }

    if (apiEvents.length > 0) {
      console.log(`Found ${apiEvents.length} events from intercepted API data`);

      const processedEvents = apiEvents
        .map(event => {
          const startDate = new Date(event.start);
          let endDate = event.end ? new Date(event.end) : startDate;

          // If end date is invalid or before start, set to start
          if (isNaN(endDate.getTime()) || endDate < startDate) {
            endDate = startDate;
          }

          // API dates are INCLUSIVE, ICS dates are EXCLUSIVE for end
          // So we need to add 1 day to the end date
          endDate = addDays(endDate, 1);

          return {
            title: event.title,
            startDate,
            endDate,
            allDay: true,
            description: `Imported from BUK (${event.source})`
          };
        })
        .filter(e => !isNaN(e.startDate.getTime()));

      if (processedEvents.length > 0) {
        console.log(`Processed ${processedEvents.length} valid events from API`);
        return deduplicateEvents(processedEvents);
      }
    }
  }

  // Fall back to DOM-based extraction
  return extractEvents(page);
}

main();
