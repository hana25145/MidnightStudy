const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = '0';
const { floorFromRoom } = require('../server');

test('A/B 동과 무관하게 방 번호에서 층을 추출한다', () => {
  assert.equal(floorFromRoom('A303'), 3);
  assert.equal(floorFromRoom('b206'), 2);
  assert.equal(floorFromRoom(' A 407 '), 4);
});

test('잘못된 방 형식은 거부한다', () => {
  assert.equal(floorFromRoom('C303'), null);
  assert.equal(floorFromRoom('A30'), null);
  assert.equal(floorFromRoom('303'), null);
});

