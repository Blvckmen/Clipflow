import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAutomaticHook, generateHook } from '../hooks.mjs';
import { defaultEdit, defaultStyle, normalizeEdit, buildAss, needsSubtitles } from '../edit.mjs';
const words = (text, start = 2) => text.split(' ').map((word, i) => [start+i*.3, start+(i+1)*.3, word]);
const edit = () => defaultEdit(defaultStyle(), {trimStart:2,trimEnd:17});
test('uses only speech within the selected clip, not the source padding', () => {
  const transcript = [...words('Secret outside source text!',0),...words('How did that ball go in?',3),...words('Outside ending footage!',20)];
  const hook=generateHook(transcript,{start:2,end:17});
  assert.equal(hook,'How did that ball go in?');
});
test('generates the hook before rendering and retains editable styling', () => {
  const original=edit();original.hook.bg='#123456';
  const result=applyAutomaticHook(original,words('How did that ball go in?'));
  assert.equal(original.hook.text,'');
  assert.equal(result.hook.text,'How did that ball go in?');
  assert.equal(result.hook.bg,'#123456');
  assert.ok(result.hook.seconds>=3 && result.hook.seconds<=6);
  assert.deepEqual(normalizeEdit(result,{duration:20}).hook,result.hook);
  const subtitle=buildAss(result,[]);
  assert.match(subtitle,/How did that ball go in\?/);
  assert.match(subtitle,/0:00:00\.00,0:00:03\.00,Hook/);
  assert.equal(needsSubtitles({...result,captions:{...result.captions,on:false}},[]),true,'hook renders even with subtitles hidden');
});
test('skips disabled generation, silence, filler and invalid words', () => {
  const original=edit();
  assert.equal(applyAutomaticHook(original,words('A useful spoken hook'),{enabled:false}),original);
  for(const transcript of [[],words('um uh okay'),words('wow'),[[NaN,3,'invalid']],null]) assert.equal(generateHook(transcript,original.trim),'');
});
test('preserves a manual title and uses corrected words', () => {
  const original=edit();original.hook.text='My own hook';
  assert.equal(applyAutomaticHook(original,words('Different spoken words')),original);
  original.hook.text='';original.words=words('These words were corrected');
  assert.equal(applyAutomaticHook(original,words('The wrong original transcript')).hook.text,'These words were corrected');
});
test('keeps long titles readable, removes subtitle commands, and honors profanity masking', () => {
  const long=words('This is a very long sentence about a surprising moment during the match that needs a short title without cutting a word in half');
  const hook=generateHook(long,{start:0,end:30});
  assert.ok(hook.length<=72);assert.ok(hook.endsWith('\u2026'));
  assert.doesNotMatch(generateHook(words('Look {\\an8}at this <b>moment</b>!'),{start:0,end:20}),/[{}\\<>]/);
  const original=edit();original.captions.mask=true;
  assert.doesNotMatch(applyAutomaticHook(original,words('What the fuck happened?')).hook.text,/fuck/i);
});
