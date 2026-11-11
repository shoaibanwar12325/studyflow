/**
 * StudyFlow – api.js
 * Third-party REST APIs (both free, keyless and CORS-enabled):
 *   • Open-Meteo forecast + geocoding  – https://open-meteo.com
 *   • GOV.UK bank holidays             – https://www.gov.uk/bank-holidays.json
 * Every call has a timeout and returns parsed data or throws a friendly error.
 */
import { weatherUrl, geocodeUrl, parseWeather, parseBankHolidays } from './core.js';

async function fetchJSON(url, { timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The request timed out.');
    if (!navigator.onLine) throw new Error('You are offline.');
    if (err instanceof TypeError) throw new Error('network error – check your connection');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function getWeather(lat, lon) {
  return parseWeather(await fetchJSON(weatherUrl(lat, lon)));
}

export async function searchPlace(name) {
  const json = await fetchJSON(geocodeUrl(name));
  return (json.results || []).map(r => ({
    name: r.name,
    detail: [r.admin1, r.country].filter(Boolean).join(', '),
    lat: r.latitude,
    lon: r.longitude,
  }));
}

export async function getBankHolidays(region) {
  return parseBankHolidays(await fetchJSON('https://www.gov.uk/bank-holidays.json'), region);
}

/** GPS via the Geolocation API – wrapped in a promise with clear error messages. */
export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Location is not supported on this device.'));
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      err => reject(new Error({
        1: 'Location permission was denied. You can still search for a city.',
        2: 'Your position could not be determined.',
        3: 'Finding your location took too long.',
      }[err.code] || 'Location unavailable.')),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 10 * 60 * 1000 },
    );
  });
}
