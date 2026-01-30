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

  // Try to extract events from various possible calendar formats
  const events = await page.evaluate(() => {
    const extractedEvents = [];
    const debug = [];

    // Strategy 1: Look for FullCalendar events (common calendar library)
    const fcEvents = document.querySelectorAll('.fc-event, .fc-event-title, [class*="fc-"]');
    debug.push(`FullCalendar elements: ${fcEvents.length}`);
    fcEvents.forEach(el => {
      const title = el.textContent?.trim();
      const parent = el.closest('[data-date]') || el.closest('.fc-day');
      const dateAttr = parent?.getAttribute('data-date') || el.getAttribute('data-date');
      if (title && title.length < 100) {
        extractedEvents.push({ title, dateStr: dateAttr, source: 'fullcalendar' });
      }
    });

    // Strategy 2: Look for calendar event elements with various class patterns
    const eventSelectors = [
      '.event', '.calendar-event', '[class*="event"]',
      '[class*="vacation"]', '[class*="ausencia"]', '[class*="leave"]',
      '[class*="licencia"]', '[class*="permiso"]', '[class*="feriado"]',
      '.fc-content', '.fc-title', '[class*="calendar-item"]'
    ];
    const eventElements = document.querySelectorAll(eventSelectors.join(', '));
    debug.push(`Event elements found: ${eventElements.length}`);

    eventElements.forEach(el => {
      const title = el.textContent?.trim();
      const dateAttr = el.getAttribute('data-date') || el.getAttribute('data-start') ||
                       el.closest('[data-date]')?.getAttribute('data-date');
      if (title && dateAttr && title.length < 100) {
        extractedEvents.push({ title, dateStr: dateAttr, source: 'events' });
      }
    });

    // Strategy 3: Look for table-based calendars
    const tableRows = document.querySelectorAll('table tr, .table-row');
    debug.push(`Table rows: ${tableRows.length}`);
    tableRows.forEach(row => {
      const cells = row.querySelectorAll('td, .cell');
      if (cells.length >= 2) {
        const possibleDate = cells[0]?.textContent?.trim();
        const possibleTitle = cells[1]?.textContent?.trim();

        if (possibleDate?.match(/\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/)) {
          extractedEvents.push({
            title: possibleTitle || 'Evento',
            dateStr: possibleDate,
            source: 'table'
          });
        }
      }
    });

    // Strategy 4: Look for list-based calendars
    const listItems = document.querySelectorAll('li, .list-item');
    listItems.forEach(li => {
      const text = li.textContent?.trim();
      const dateMatch = text?.match(/(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/);
      if (dateMatch) {
        extractedEvents.push({
          title: text.replace(dateMatch[0], '').trim() || 'Evento',
          dateStr: dateMatch[1],
          source: 'list'
        });
      }
    });

    // Strategy 5: BUK specific - look for any day cells with content
    const dayCells = document.querySelectorAll('[class*="day"], [class*="cell"], td[class]');
    debug.push(`Day cells: ${dayCells.length}`);
    dayCells.forEach(cell => {
      const date = cell.getAttribute('data-date') || cell.getAttribute('data-day');
      const content = cell.querySelector('[class*="event"], [class*="item"], span, div');
      if (date && content && content.textContent?.trim()) {
        extractedEvents.push({
          title: content.textContent.trim(),
          dateStr: date,
          source: 'daycell'
        });
      }
    });

    console.log('Debug info:', debug.join('; '));
    return { events: extractedEvents, debug };
  });

  console.log('Extraction debug:', events.debug.join('; '));
  console.log(`Found ${events.events.length} raw events`);

  // Process and format events
  const rawEvents = events.events;
  const processedEvents = rawEvents
    .filter(e => e.dateStr && e.title)
    .map(event => {
      const startDate = parseDate(event.dateStr);
      const endDate = addDays(startDate, 1);

      return {
        title: event.title,
        startDate,
        endDate,
        allDay: true,
        description: `Imported from BUK (${event.source})`
      };
    })
    .filter(e => !isNaN(e.startDate.getTime()));

  console.log(`Processed ${processedEvents.length} valid events`);
  return processedEvents;
}

async function main() {
  console.log('Starting BUK calendar scraper...');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    // Set viewport and user agent
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Login to BUK
    await login(page);

    // Navigate to calendar section
    await navigateToCalendar(page);

    // Extract events
    const events = await extractEvents(page);

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
      const currentUrl = page.url();
      console.log('Current URL:', currentUrl);
      const pageTitle = await page.title();
      console.log('Page title:', pageTitle);
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

main();
