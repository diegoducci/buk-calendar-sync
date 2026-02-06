import icalGenerator from 'ical-generator';
import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Generate a deterministic UID based on event title and date.
 * This ensures the same event always gets the same UID across runs,
 * preventing Google Calendar from creating duplicates on feed refresh.
 */
function generateUID(event) {
  const date = new Date(event.startDate).toISOString().split('T')[0];
  const hash = createHash('md5').update(`${event.title}|${date}`).digest('hex');
  return `${hash}@buk-calendar-sync`;
}

/**
 * Generates an ICS calendar file from extracted events
 * @param {Array} events - Array of event objects with title, startDate, endDate
 * @returns {string} Path to the generated ICS file
 */
export function generateICS(events) {
  const calendar = icalGenerator({
    name: 'BUK Calendar - Costasur',
    timezone: 'America/Santiago',
    prodId: { company: 'buk-calendar-sync', product: 'BUK Calendar' }
  });

  for (const event of events) {
    calendar.createEvent({
      id: generateUID(event),
      start: event.startDate,
      end: event.endDate,
      summary: event.title,
      description: event.description || '',
      allDay: event.allDay ?? true
    });
  }

  const outputPath = join(__dirname, '..', 'public', 'calendar.ics');
  writeFileSync(outputPath, calendar.toString());

  console.log(`Generated ICS file with ${events.length} events at ${outputPath}`);
  return outputPath;
}
