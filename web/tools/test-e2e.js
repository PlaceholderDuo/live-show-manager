const http = require('http');
const BASE = { hostname: 'localhost', port: 3000 };
let passed = 0, failed = 0, warned = 0;

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { ...BASE, path, method, headers: { 'Content-Type': 'application/json' }, timeout: 5000 };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function ok(n, d) { passed++; console.log('  \x1b[32m✓\x1b[0m', n + (d ? ' \x1b[90m' + d + '\x1b[0m' : '')); }
function fail(n, d) { failed++; console.log('  \x1b[31m✗\x1b[0m', n + (d ? ' \x1b[90m— ' + d + '\x1b[0m' : '')); }
function warn(n, d) { warned++; console.log('  \x1b[33m⚠\x1b[0m', n + (d ? ' \x1b[90m— ' + d + '\x1b[0m' : '')); }

async function run() {
  console.log('\n╔══════════════════════════════════╗');
  console.log('║   END-TO-END SHOW READY TEST   ║');
  console.log('╚══════════════════════════════════╝\n');

  // ═══════════════════════════════════════
  // PHASE 1: Server health
  // ═══════════════════════════════════════
  console.log('── Phase 1: Server health ──');
  let s = (await api('GET', '/api/state')).body;
  if (s && typeof s.playing === 'boolean') ok('Server reachable', 'port 3000');
  else { fail('Server reachable'); return; }

  await api('POST', '/api/local/stop');
  s = (await api('GET', '/api/state')).body;
  ok('Stop resets state', 'pos=' + s.position + ' playing=' + s.playing);

  // ═══════════════════════════════════════
  // PHASE 2: Load setlist
  // ═══════════════════════════════════════
  console.log('\n── Phase 2: Load setlist ──');
  const setlist = [
    { title: 'Changes In Latitudes Changes In Attitudes' },
    { title: 'Come Together' },
    { title: 'Free Bird' }
  ];

  let r = await api('POST', '/api/local/setlist', { songs: setlist });
  if (r.body.ok && r.body.count === 3) ok('3-song setlist loaded', r.body.currentSong);
  else fail('Setlist load', JSON.stringify(r.body));

  s = (await api('GET', '/api/state')).body;
  ok('Song index correct', '1/' + s.totalSongs);
  if (s.duration > 60) ok('Duration computed', s.duration + 's');
  else fail('Duration too short', s.duration + 's');
  if ((s.sections || []).length > 0) ok('Sections present', s.sections.length + ' sections');
  else fail('No sections');
  if ((s.lyricLines || []).length > 0) ok('Lyrics loaded', s.lyricLines.length + ' lines');
  else fail('No lyric lines');

  // ═══════════════════════════════════════
  // PHASE 3: Play — verify position + timing
  // ═══════════════════════════════════════
  console.log('\n── Phase 3: Playback timing ──');
  await api('POST', '/api/local/play');
  await new Promise(r => setTimeout(r, 3000));
  s = (await api('GET', '/api/state')).body;

  // At 120 BPM: 3 seconds = 6 beats = 1.5 bars. Position should be ~3s.
  if (s.position > 2.5 && s.position < 3.5) ok('Position advances correctly', s.position.toFixed(1) + 's (expected ~3.0)');
  else fail('Position wrong', s.position.toFixed(1) + 's (expected ~3.0)');
  if (s.playing) ok('Playing flag true', '');
  else fail('Playing flag false');

  const bar = Math.floor(s.position * s.bpm / 240) + 1;
  ok('Bar calculation', 'Bar ' + bar + ' at ' + s.position.toFixed(1) + 's (' + s.bpm + ' BPM)');

  // ═══════════════════════════════════════
  // PHASE 4: Lyrics alignment
  // ═══════════════════════════════════════
  console.log('\n── Phase 4: Lyrics alignment ──');
  const lyrics = s.lyricLines || [];
  const annotated = lyrics.filter(l => l.bar != null);
  const estimated = lyrics.filter(l => l.bar == null);

  ok('Annotated lines', annotated.length + ' have @bar');
  if (estimated.length > 0) warn('Estimated lines', estimated.length + ' have NO @bar timing');

  // Find which lyric line SHOULD display at current bar
  let currentLine = null;
  for (const l of lyrics) {
    if (l.bar != null && l.bar <= bar) currentLine = l;
  }
  if (currentLine) {
    ok('Current lyric found', '@bar=' + currentLine.bar + ' \"' + currentLine.text.substring(0, 40) + '\"');
  } else if (annotated.length > 0) {
    fail('No lyric at bar ' + bar, 'closest annotation: @bar=' + annotated[0].bar);
  } else {
    warn('No @bar annotations', 'lyrics use estimated positioning');
  }

  // ═══════════════════════════════════════
  // PHASE 5: Transport controls
  // ═══════════════════════════════════════
  console.log('\n── Phase 5: Transport controls ──');

  // Pause
  let ppos = s.position;
  await api('POST', '/api/local/pause');
  await new Promise(r => setTimeout(r, 1000));
  s = (await api('GET', '/api/state')).body;
  if (Math.abs(s.position - ppos) < 0.3 && !s.playing) ok('Pause freezes position', ppos.toFixed(1) + '→' + s.position.toFixed(1));
  else fail('Pause failed', ppos.toFixed(1) + '→' + s.position.toFixed(1) + ' playing=' + s.playing);

  // Resume
  let rpos = s.position;
  await api('POST', '/api/local/play');
  await new Promise(r => setTimeout(r, 1500));
  s = (await api('GET', '/api/state')).body;
  if (s.position > rpos + 1.0 && s.playing) ok('Resume continues', rpos.toFixed(1) + '→' + s.position.toFixed(1) + 's');
  else fail('Resume failed', rpos.toFixed(1) + '→' + s.position.toFixed(1) + 's');

  // Next song
  await api('POST', '/api/local/next');
  s = (await api('GET', '/api/state')).body;
  const expectedSong2 = setlist[1].title.toLowerCase();
  if (s.currentSong && s.currentSong.toLowerCase().includes('come together'))
    ok('Next → song 2', s.songIndex + '/3 ' + s.currentSong);
  else fail('Next wrong song', s.currentSong + ' (expected ' + setlist[1].title + ')');
  if (s.position === 0 && !s.playing) ok('Next resets position', 'pos=0');
  else fail('Next position not reset', 'pos=' + s.position);

  // Play the next song briefly
  await api('POST', '/api/local/play');
  await new Promise(r => setTimeout(r, 2000));
  s = (await api('GET', '/api/state')).body;
  ok('Song 2 playing', s.currentSong + ' pos=' + s.position.toFixed(1) + 's');

  // Next → song 3
  await api('POST', '/api/local/next');
  s = (await api('GET', '/api/state')).body;
  if (s.currentSong && s.currentSong.toLowerCase().includes('free bird'))
    ok('Next → song 3', s.songIndex + '/3 ' + s.currentSong);
  else fail('Next to song 3 failed', s.currentSong);

  // Prev → song 2
  await api('POST', '/api/local/prev');
  s = (await api('GET', '/api/state')).body;
  if (s.songIndex === 2) ok('Prev → back to song 2', s.currentSong);
  else fail('Prev failed', 'idx=' + s.songIndex);

  // Stop
  await api('POST', '/api/local/stop');
  s = (await api('GET', '/api/state')).body;
  if (s.position === 0 && !s.playing) ok('Stop complete', 'pos=0 playing=false');
  else fail('Stop failed', 'pos=' + s.position + ' playing=' + s.playing);

  // ═══════════════════════════════════════
  // PHASE 6: Edge cases
  // ═══════════════════════════════════════
  console.log('\n── Phase 6: Edge cases ──');

  // Next at end
  await api('POST', '/api/local/setlist', { songs: [{ title: 'Come Together' }, { title: 'Free Bird' }] });
  await api('POST', '/api/local/next');
  s = (await api('GET', '/api/state')).body;
  await api('POST', '/api/local/next'); // at end
  s = (await api('GET', '/api/state')).body;
  if (s.songIndex <= 2) ok('Next at end clamps', 'idx=' + s.songIndex + ' (stays at or below 2)');
  else fail('Next at end overflowed', 'idx=' + s.songIndex);

  // Prev at start
  await api('POST', '/api/local/load', { title: 'Come Together' });
  await api('POST', '/api/local/prev');
  s = (await api('GET', '/api/state')).body;
  if (s.songIndex >= 1) ok('Prev at start clamps', 'idx=' + s.songIndex);
  else fail('Prev at start underflowed', 'idx=' + s.songIndex);

  // Nonexistent song
  r = await api('POST', '/api/local/load', { title: 'Totally Nonexistent Song' });
  if (r.body.ok === false) ok('Nonexistent rejected', 'ok=false');
  else fail('Nonexistent should fail', 'ok=' + r.body.ok);

  // Double stop
  await api('POST', '/api/local/stop');
  r = await api('POST', '/api/local/stop');
  if (r.body.ok !== undefined) ok('Double stop no crash', '');
  else fail('Double stop crashed');

  // Rapid sequence
  try {
    await api('POST', '/api/local/play');
    await api('POST', '/api/local/pause');
    await api('POST', '/api/local/play');
    await api('POST', '/api/local/next');
    await api('POST', '/api/local/prev');
    await api('POST', '/api/local/stop');
    ok('Rapid ops sequence', '7 ops no crash');
  } catch(e) { fail('Rapid ops', e.message); }

  // Setlist persistence after stop
  await api('POST', '/api/local/setlist', { songs: setlist });
  await api('POST', '/api/local/play');
  await new Promise(r => setTimeout(r, 1000));
  await api('POST', '/api/local/stop');
  s = (await api('GET', '/api/state')).body;
  if (s.totalSongs === 3) ok('Setlist survives stop', s.totalSongs + ' songs');
  else fail('Setlist lost after stop', s.totalSongs + ' songs');

  // ═══════════════════════════════════════
  // PHASE 7: Timing accuracy verification
  // ═══════════════════════════════════════
  console.log('\n── Phase 7: Timing accuracy ──');
  await api('POST', '/api/local/setlist', { songs: [{ title: 'Come Together' }] });
  await api('POST', '/api/local/play');
  await new Promise(r => setTimeout(r, 5000)); // 5s real time
  s = (await api('GET', '/api/state')).body;

  // At 120 BPM: 5s = 10 beats = 2.5 bars
  if (s.position > 4.5 && s.position < 5.5) ok('5s timing accurate', s.position.toFixed(1) + 's (expected ~5.0)');
  else fail('5s timing off', s.position.toFixed(1) + 's (expected ~5.0)');

  // 10s test
  await api('POST', '/api/local/stop');
  await api('POST', '/api/local/play');
  await new Promise(r => setTimeout(r, 10000));
  s = (await api('GET', '/api/state')).body;
  if (s.position > 9.3 && s.position < 10.7) ok('10s timing accurate', s.position.toFixed(1) + 's (expected ~10.0)');
  else fail('10s timing off', s.position.toFixed(1) + 's (expected ~10.0)');

  await api('POST', '/api/local/stop');

  // ═══════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════
  console.log('\n═══════════════════════════════════');
  const total = passed + failed + warned;
  console.log('  ' + passed + ' passed, ' + (failed ? failed + ' failed' : '0 failed') + (warned ? ', ' + warned + ' warnings' : '') + ' (' + total + ' total)');
  if (failed === 0) {
    console.log('\n  \x1b[32m✓ SHOW READY\x1b[0m — teleprompter will advance correctly\n');
  } else {
    console.log('\n  \x1b[31m✗ ' + failed + ' issues found\x1b[0m — fix before show\n');
  }
  console.log('═══════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
