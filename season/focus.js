/**
 * Optional "focus team" mode for the morning report and news digest.
 *
 * REPORT_TEAMS="Fishy" (a case-insensitive part of one team's name; several names separated by |)
 * makes the scripts treat those teams as the managed teams instead of your two. Output goes to files
 * with a suffix (reports/YYYY-MM-DD-fishy.md, reports/YYYY-MM-DD-news-fishy.md) so the normal daily
 * files are never overwritten. Returns null when REPORT_TEAMS is not set.
 */
function applyFocus(league, env = process.env) {
  const wanted = (env.REPORT_TEAMS || '').split('|').map(s => s.trim()).filter(Boolean);
  if (!wanted.length) return null;
  const names = wanted.map(w => {
    const hits = league.teams.filter(t => t.name.toLowerCase().includes(w.toLowerCase()) || (t.previousNames || []).some(p => p.toLowerCase().includes(w.toLowerCase())));
    if (hits.length !== 1) throw new Error(`REPORT_TEAMS "${w}" matches ${hits.length} teams`);
    return hits[0].name;
  });
  league.managedTeams = names;
  league.myTeam = null;
  const first = names[0].split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, '') || 'team';
  league.managedLabel = `(${first})`;
  return { names, slug: first.toLowerCase() };
}
module.exports = { applyFocus };
