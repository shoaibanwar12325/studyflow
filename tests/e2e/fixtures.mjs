// Recorded-shape API responses used to mock the network in E2E tests (deterministic + works offline).
export function weatherFixture(startIso) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(startIso); d.setDate(d.getDate() + i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  return {
    latitude: 56.46, longitude: -2.97, timezone: 'Europe/London',
    current: { time: `${days[0]}T09:00`, temperature_2m: 7.6, apparent_temperature: 4.2, weather_code: 61, wind_speed_10m: 19.4, precipitation: 0.3 },
    daily: {
      time: days,
      weather_code: [61, 3, 2, 80, 0, 1, 63],
      temperature_2m_max: [9.1, 8.4, 10.2, 7.9, 6.5, 8.8, 9.6],
      temperature_2m_min: [3.2, 2.1, 4.4, 1.9, -0.5, 2.6, 4.1],
      precipitation_probability_max: [72, 20, 10, 55, 0, 5, 80],
    },
  };
}

export const geocodeFixture = {
  results: [
    { name: 'Edinburgh', latitude: 55.95206, longitude: -3.19648, country: 'United Kingdom', admin1: 'Scotland' },
    { name: 'Edinburgh', latitude: 39.20, longitude: -85.96, country: 'United States', admin1: 'Indiana' },
  ],
};

export function holidaysFixture(year) {
  const ev = (title, date) => ({ title, date, notes: '', bunting: true });
  return {
    'scotland': { division: 'scotland', events: [ev('New Year’s Day', `${year}-01-01`), ev('St Andrew’s Day', `${year}-11-30`), ev('Christmas Day', `${year}-12-25`), ev('Boxing Day', `${year}-12-28`), ev('New Year’s Day', `${year + 1}-01-01`), ev('2nd January', `${year + 1}-01-04`)] },
    'england-and-wales': { division: 'england-and-wales', events: [ev('Christmas Day', `${year}-12-25`), ev('Boxing Day', `${year}-12-28`)] },
    'northern-ireland': { division: 'northern-ireland', events: [ev('Christmas Day', `${year}-12-25`)] },
  };
}
