import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionRequest, captionLimit, generateSocialCaptions, socialCaptionsAvailable } from '../lib/social-caption.ts';
const input = { topic: 'Launching iced matcha this Friday at our caf�.', platform: 'Instagram', tone: 'Casual', length: 'Short', emojis: false, hashtags: true };
const env = { OPENAI_API_KEY: 'test-only' };
const good = ['Matcha is coming Friday. #Matcha #Cafe', 'Your Friday plans: iced matcha. #Cafe #Matcha', 'A fresh pour for Friday. #Matcha #Cafe'];
const reply = (captions = good, extra = {}) => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ captions }) }, ...extra }] });
test('validates descriptions and editorial limits', () => {
  for (const topic of [' ', 'a'.repeat(3001)]) assert.equal(captionRequest.safeParse({ ...input, topic }).success, false);
  assert.equal(captionRequest.safeParse({ ...input, platform: 'unknown' }).success, false);
  assert.equal(captionRequest.safeParse(input).success, true);
  assert.equal(captionLimit({ platform: 'X', length: 'Short' }), 240);
  for (const length of ['Medium', 'Long']) assert.equal(captionLimit({ platform: 'X', length }), 280);
  assert.equal(captionLimit({ platform: 'Instagram', length: 'Long' }), 1400);
  assert.equal(socialCaptionsAvailable({ OPENAI_API_KEY: ' ' }), false);
});
test('uses OpenAI strict structured output, server credentials and model precedence', async () => {
  const calls = [];
  const mock = async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return reply(); };
  const result = await generateSocialCaptions(env, input, mock);
  assert.deepEqual(result.captions, good); assert.equal(result.limit, 240);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-only');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].body.model, 'gpt-4o-mini');
  assert.equal(calls[0].body.response_format.json_schema.strict, true);
  assert.match(calls[0].body.messages[0].content, /Do not use emoji/);
  assert.equal(calls[0].body.messages[1].content, input.topic);
  await generateSocialCaptions({ ...env, OPENAI_GENERATION_MODEL: 'general-model' }, input, mock);
  assert.equal(calls[1].body.model, 'general-model');
  await generateSocialCaptions({ ...env, OPENAI_GENERATION_MODEL: 'general-model', OPENAI_SOCIAL_CAPTION_MODEL: 'caption-model' }, input, mock);
  assert.equal(calls[2].body.model, 'caption-model');
  await assert.rejects(generateSocialCaptions({}, input, mock), /OPENAI_API_KEY/);
  assert.equal(calls.length, 3);
});
test('rejects invalid, duplicate, overlong, refused and incomplete output', async () => {
  for (const captions of [[], ['same', 'same', 'same'], ['x'.repeat(241), 'two', 'three'], [' ', 'two', 'three']]) {
    await assert.rejects(generateSocialCaptions(env, input, async () => reply(captions)), /format/);
  }
  await assert.rejects(generateSocialCaptions(env, input, async () => reply(good, { message: { refusal: 'refused' } })), /rephrasing/);
  await assert.rejects(generateSocialCaptions(env, input, async () => reply(good, { finish_reason: 'length' })), /incomplete/);
  await assert.rejects(generateSocialCaptions(env, { ...input, hashtags: false }, async () => reply()), /format/);
  await assert.rejects(generateSocialCaptions(env, input, async () => reply(['Hello \u{1f44b}', 'two', 'three'])), /format/);
  const result = await generateSocialCaptions(env, { ...input, emojis: true }, async () => reply(['\u{1f389}'.repeat(240), 'two', 'three']));
  assert.equal(Array.from(result.captions[0]).length, 240);
});
test('handles provider failures without leaking response content or credentials', async () => {
  await assert.rejects(generateSocialCaptions(env, input, async () => new Response('secret', { status: 429 })), /busy/);
  await assert.rejects(generateSocialCaptions(env, input, async () => new Response('secret', { status: 401 })), /server configuration/);
  await assert.rejects(generateSocialCaptions(env, input, async () => { throw new Error('secret'); }), /timed out or could not connect/);
});
