/** 'YYYY-MM-DD' in local (Manila) time. Use instead of toISOString(), which is UTC. */
function localDate(d = new Date()) {
  const date = d instanceof Date ? d : new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

module.exports = { localDate };
