const http = require('http');
const BASE = { hostname: 'localhost', port: 3000 };
let passed = 0, failed = 0;

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

async function check(name, condition, detail) {
  try {
    const ok = typeof condition === 'function' ? await condition() : condition;
    console.log('  ' + (ok ? 'OK' : 'FAIL') + '  ', name + (detail ? ' — ' + detail : ''));
    if (ok) passed++; else failed++;
    return ok;
  } catch(e) { failed++; console.log('  FAIL ', name, '-', e.message); return false; }
}

async function run() {
  console.log('\n=== Full System Test ===\n');
  let r, s;

  console.log('Server health:');
  s = (await api('GET', '/api/state')).body;
  await check('Server reachable', s && typeof s.playing === 'boolean');
  r = await api('GET', '/bumper/api/status');
  await check('Bumper API', r.status === 200);
  r = await api('GET', '/api/chordpro/wild_horses');
  await check('ChordPro API', r.status === 200 && r.body.length > 100);
  r = await api('GET', '/api/clients');
  await check('Clients API', r.status === 200);

  console.log('\nSetlist:');
  r = await api('POST', '/api/local/setlist', {
    songs: [{ title: 'Come Together' }, { title: 'Free Bird' }, { title: 'Wild Horses' }]
  });
  await check('Setlist loaded', r.body.ok && r.body.count === 3, r.body.count + ' songs');
  s = (await api('GET', '/api/state')).body;
  await check('Song 1 loaded', s.currentSong && s.currentSong.toLowerCase().includes('come together'), s.currentSong);
  await check('Duration > 0', s.duration > 60, s.duration + 's');
  await check('Sections present', (s.sections || []).length > 0, s.sections.length + ' sections');
  await check('Lyrics present', (s.lyricLines || []).length > 0, s.lyricLines.length + ' lines');

  console.log('\nTransport:');
  await api('POST', '/api/local/stop');
  r = await api('POST', '/api/local/play');
  await check('Play start', r.body.playing);
  await new Promise(r => setTimeout(r, 2000));
  s = (await api('GET', '/api/state')).body;
  await check('Pos advances', s.position > 1.5, s.position.toFixed(1) + 's');
  await check('Playing true', s.playing);

  r = await api('POST', '/api/local/pause');
  let pp = (await api('GET', '/api/state')).body.position;
  await new Promise(r => setTimeout(r, 1000));
  s = (await api('GET', '/api/state')).body;
  await check('Pause freezes', Math.abs(s.position - pp) < 0.3, pp.toFixed(1) + '→' + s.position.toFixed(1));
  await check('Pause flag off', !s.playing);

  r = await api('POST', '/api/local/play');
  await new Promise(r => setTimeout(r, 500));
  s = (await api('GET', '/api/state')).body;
  await check('Resume works', s.playing && s.position > pp, 'pos=' + s.position.toFixed(1));

  r = await api('POST', '/api/local/stop');
  s = (await api('GET', '/api/state')).body;
  await check('Stop reset', s.position === 0 && !s.playing);

  console.log('\nNavigation:');
  r = await api('POST', '/api/local/setlist', { songs: [{ title: 'Come Together' }, { title: 'Free Bird' }, { title: 'Wild Horses' }] });
  s = (await api('GET', '/api/state')).body;
  await check('S1: Come Together', s.songIndex === 1, s.currentSong);

  r = await api('POST', '/api/local/next');
  s = (await api('GET', '/api/state')).body;
  await check('S2: Free Bird', s.songIndex === 2, s.currentSong);

  r = await api('POST', '/api/local/next');
  s = (await api('GET', '/api/state')).body;
  await check('S3: Wild Horses', s.songIndex === 3, s.currentSong);

  r = await api('POST', '/api/local/next');
  s = (await api('GET', '/api/state')).body;
  await check('Next at end stays', s.songIndex <= 3, 'idx=' + s.songIndex);

  r = await api('POST', '/api/local/prev');
  r = await api('POST', '/api/local/prev');
  s = (await api('GET', '/api/state')).body;
  await check('Prev twice → S1', s.songIndex === 1, s.currentSong);

  r = await api('POST', '/api/local/prev');
  s = (await api('GET', '/api/state')).body;
  await check('Prev at start stays', s.songIndex >= 1, 'idx=' + s.songIndex);

  console.log('\nError handling:');
  r = await api('POST', '/api/local/load', { title: 'Nonexistent Song' });
  await check('Not found', r.body.ok === false);
  s = (await api('GET', '/api/state')).body;
  await check('State unchanged', !!s.currentSong);

  console.log('\nEdge cases:');
  await api('POST', '/api/local/stop');
  r = await api('POST', '/api/local/stop'); // double stop
  await check('Double stop ok', r.body.ok !== undefined);
  r = await api('POST', '/api/local/setlist', { songs: [] });
  await check('Empty setlist ok', r.body.ok !== undefined);

  await api('POST', '/api/local/setlist', { songs: [{ title: 'Come Together' }, { title: 'Free Bird' }] });
  await api('POST', '/api/local/play');
  r = await api('POST', '/api/local/play'); // double play
  s = (await api('GET', '/api/state')).body;
  await check('Double play no crash', s.playing);

  await api('POST', '/api/local/play'); // multiple rapid
  await api('POST', '/api/local/next');
  await api('POST', '/api/local/pause');
  await api('POST', '/api/local/play');
  await api('POST', '/api/local/prev');
  await api('POST', '/api/local/stop');
  s = (await api('GET', '/api/state')).body;
  await check('Rapid ops no crash', s && typeof s.playing === 'boolean');
  await check('Rapid ops: state clean', s.position === 0 && !s.playing, 'pos=' + s.position + ' playing=' + s.playing);

  console.log(`\n  ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
