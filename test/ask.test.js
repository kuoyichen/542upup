const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('里名清單', () => {
  const VILLAGES = require('../api/_villages');

  // 草屯鎮正式里數 27（中選會 111 年草屯鎮里長選舉公報，第 1~4 選區合計 7+6+6+8），再加「外地鄉親」= 28
  // 來源：https://eebulletin.cec.gov.tw/ ?dir=111/11南投縣/05村里長
  it('筆數 = 官方 27 里 + 外地鄉親', () => {
    assert.equal(VILLAGES.length, 28);
  });
  it('無重複', () => {
    assert.equal(new Set(VILLAGES).size, VILLAGES.length);
  });
  it('除最後一項外都以「里」結尾', () => {
    for (const v of VILLAGES.slice(0, -1)) assert.match(v, /里$/);
  });
  it('最後一項是外地鄉親', () => {
    assert.equal(VILLAGES[VILLAGES.length - 1], '外地鄉親');
  });
});
