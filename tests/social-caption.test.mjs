import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { localDrafts, transcriptText, keywordTags } from '../lib/local-captions.mjs';
import { captionRequest, generateSocialCaptions } from '../lib/social-caption.ts';
import { captionClip, captionForPost, fillCaptions, CLIP_FACTS_SQL, factsFromRow, writeCaption } from '../lib/post-caption.ts';
const input = { topic: 'We planted tomatoes in the garden today. The tomatoes need water.', platform: 'Instagram', tone: 'Casual', length: 'Short', emojis: false, hashtags: true };

test('requires a description or a valid clip ID; no keys or network are needed', () => {
  assert.equal(captionRequest.safeParse({ ...input, topic: ' ' }).success, false);
  assert.equal(captionRequest.safeParse({ ...input, topic: 'x'.repeat(3001) }).success, false);
  assert.equal(captionRequest.safeParse({ ...input, topic: '', clipId: 'bed11c5a-5ca0-4b31-bca4-122436506aba' }).success, true);
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network must not be used'); };
  try { assert.equal(generateSocialCaptions({}, input).captions.length, 3); }
  finally { globalThis.fetch = original; }
});
test('all tone, platform and length choices produce three distinct bounded captions', () => {
  for (const platform of ['Instagram', 'TikTok', 'YouTube', 'Facebook', 'LinkedIn', 'X'])
  for (const tone of ['Casual', 'Funny', 'Professional', 'Inspirational', 'Bold'])
  for (const length of ['Short', 'Medium', 'Long']) {
    const result = localDrafts({ ...input, text: 'Gardening vegetables tomatoes cucumbers '.repeat(80), streamer: 'A'.repeat(100), platform, tone, length, emojis: true });
    assert.equal(new Set(result.captions).size, 3);
    for (const caption of result.captions) {
      assert.ok(Array.from(caption).length <= result.limit, `${platform} ${tone} ${length}: ${Array.from(caption).length}/${result.limit}`);
      assert.match(caption, /Clip: /);
    }
  }
});
test('hashtags derive from actual words, de-duplicate, and respect toggles', () => {
  assert.deepEqual(keywordTags('tomatoes tomatoes garden', ['Dan', 'dan']), ['#Dan', '#tomatoes', '#garden']);
  const result = localDrafts({ ...input, text: 'Enjoy the garden #plants \u{1f331}', streamer: '#Dan\u{1f44b}', hashtags: false, emojis: false });
  assert.ok(result.captions.every(c => !/#|\p{Extended_Pictographic}/u.test(c)));
  assert.throws(() => localDrafts({ ...input, text: '' }), /No transcript/);
});
test('transcripts honor saved trims, corrections and hidden words', async () => {
  const words = [[0,1,'outside'],[2,3,'Fresh'],[3,4,'tomatoes!'],[4,5,''],[8,9,'excluded']];
  assert.equal(transcriptText(words, { start:2, end:5 }), 'Fresh tomatoes!');
  const row = { streamer:'Dan', platform:'Twitch', transcript:JSON.stringify(words), edit:JSON.stringify({trim:{start:2,end:5},words:[[2,3,'Ripe'],[3,4,'tomatoes!']]}), caption_notes:'#garden', live_title:null, reason:null };
  const parts = await writeCaption({}, factsFromRow(row));
  assert.equal(parts.title, 'Ripe tomatoes!');
  assert.match(parts.body, /Dan on Twitch/);
  assert.ok(parts.hashtags.includes('#garden'));
  assert.doesNotMatch(JSON.stringify(parts), /outside|excluded|Fresh/);
});
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE clips(id TEXT PRIMARY KEY,owner TEXT,streamer_id TEXT,reason TEXT,transcript TEXT,edit TEXT,edit_rev INTEGER DEFAULT 0,post_caption TEXT,caption_source TEXT,caption_error TEXT,caption_tries INTEGER DEFAULT 0,review TEXT DEFAULT 'approved',created_at TEXT);
    CREATE TABLE streamers(id TEXT,owner TEXT,name TEXT,platform TEXT,live_title TEXT);
    CREATE TABLE preferences(owner TEXT,caption_notes TEXT,ai_captions INTEGER);
    INSERT INTO streamers VALUES('stream','owner','Dan','Twitch',NULL);
    INSERT INTO preferences VALUES('owner','#garden',1);`);
  const env = { DB: { prepare(sql) { return { bind(...args) { return {
    async run() { const r=sqlite.prepare(sql).run(...args); return {meta:{changes:Number(r.changes)}}; },
    async first() { return sqlite.prepare(sql).get(...args) ?? null; },
    async all() { return {results:sqlite.prepare(sql).all(...args)}; }
  }; } }; } } };
  const add=(id, words=[[1,2,'Fresh'],[2,3,'tomatoes!']])=>sqlite.prepare('INSERT INTO clips(id,owner,streamer_id,transcript,edit,created_at) VALUES(?,?,?,?,?,?)').run(id,'owner','stream',JSON.stringify(words),JSON.stringify({trim:{start:0,end:5}}),new Date().toISOString());
  const row=id=>sqlite.prepare(CLIP_FACTS_SQL+' WHERE c.id=?').get(id);
  return {sqlite,env,add,row};
}
test('automatic captions work without keys, while silence and opt-out use fallback', async () => {
  const {sqlite,env,add,row}=database();
  try {
    add('speech'); add('silent',[]);
    await fillCaptions(env);
    assert.equal(row('speech').post_caption.split('\n')[0], 'Fresh tomatoes!');
    assert.equal(sqlite.prepare('SELECT caption_source FROM clips WHERE id=?').get('speech').caption_source,'local');
    assert.equal(await captionForPost(env,'silent'),null);
    sqlite.exec('UPDATE preferences SET ai_captions=0'); add('disabled');
    assert.equal(await captionForPost(env,'disabled'),null);
  } finally { sqlite.close(); }
});
test('manual text and concurrent edits survive automatic and explicit generation', async () => {
  const {sqlite,env,add,row}=database();
  try {
    add('manual'); sqlite.exec("UPDATE clips SET post_caption='My caption',caption_source='edited'");
    assert.equal(await captionClip(env,row('manual')),'My caption');
    const snapshot=row('manual');
    sqlite.exec("UPDATE clips SET post_caption='Newer manual text'");
    await assert.rejects(captionClip(env,snapshot,true), /changed/);
    assert.equal(await captionForPost(env,'manual'),'Newer manual text');
    await captionClip(env,row('manual'),true);
    assert.match(row('manual').post_caption,/Fresh tomatoes!/);
    const old=row('manual');sqlite.exec('UPDATE clips SET edit_rev=1');
    await assert.rejects(captionClip(env,old,true),/changed/);
  } finally { sqlite.close(); }
});
