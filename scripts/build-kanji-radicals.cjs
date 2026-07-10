// One-off data pipeline: adds a `radical` (Kangxi radical number 1-214) field to every
// entry in data/kanji/kanji-en.json, and generates data/kanji/radicals.json describing
// the 214 traditional (Khang Hy) radicals.
//
// Sources:
// - Kanji -> radical number mapping: derived from Unicode Unihan database (kRSKangXi
//   field, Unihan_RadicalStrokeCounts.txt, version 15.0), pre-parsed into
//   data/kanji/_unihan-radical-map.json so this script has no network dependency.
// - Radical number -> representative character: official Unicode UCD file
//   CJKRadicals.txt (radical number -> CJK Unified Ideograph equivalent), embedded
//   below since it's a stable, unchanging 214-row table. Two entries (63, 174) use
//   the traditional glyph in the UCD file (戶, 靑) which isn't present in the Japanese
//   Joyo-focused kanji-en.json dataset; overridden here with the modern Japanese forms
//   (戸, 青) which ARE present and are the same radical.
// - Stroke count / Han Viet name / Vietnamese & English meaning for each radical: looked
//   up from the existing kanji-en.json / kanjiData.json entry for that representative
//   character (the radical character is itself a normal standalone kanji), so no data
//   is hand-transcribed.

const fs = require('fs');
const path = require('path');

const BACKEND_DATA_DIR = path.resolve(__dirname, '../data/kanji');
const FRONTEND_DATA_DIR = path.resolve(__dirname, '../../vocab-frontend/public/data/kanji');

const RADICAL_NUMBER_TO_CHAR_OVERRIDES = {
  63: '戸', // UCD gives traditional 戶; kanji-en.json only has the Japanese modern form
  174: '青', // UCD gives traditional 靑; kanji-en.json only has the Japanese modern form
};

// number -> representative CJK Unified Ideograph, from Unicode UCD CJKRadicals.txt
const RADICAL_NUMBER_TO_CHAR = [
  [1,'一'],[2,'丨'],[3,'丶'],[4,'丿'],[5,'乙'],[6,'亅'],[7,'二'],[8,'亠'],[9,'人'],[10,'儿'],
  [11,'入'],[12,'八'],[13,'冂'],[14,'冖'],[15,'冫'],[16,'几'],[17,'凵'],[18,'刀'],[19,'力'],[20,'勹'],
  [21,'匕'],[22,'匚'],[23,'匸'],[24,'十'],[25,'卜'],[26,'卩'],[27,'厂'],[28,'厶'],[29,'又'],[30,'口'],
  [31,'囗'],[32,'土'],[33,'士'],[34,'夂'],[35,'夊'],[36,'夕'],[37,'大'],[38,'女'],[39,'子'],[40,'宀'],
  [41,'寸'],[42,'小'],[43,'尢'],[44,'尸'],[45,'屮'],[46,'山'],[47,'巛'],[48,'工'],[49,'己'],[50,'巾'],
  [51,'干'],[52,'幺'],[53,'广'],[54,'廴'],[55,'廾'],[56,'弋'],[57,'弓'],[58,'彐'],[59,'彡'],[60,'彳'],
  [61,'心'],[62,'戈'],[63,'戶'],[64,'手'],[65,'支'],[66,'攴'],[67,'文'],[68,'斗'],[69,'斤'],[70,'方'],
  [71,'无'],[72,'日'],[73,'曰'],[74,'月'],[75,'木'],[76,'欠'],[77,'止'],[78,'歹'],[79,'殳'],[80,'毋'],
  [81,'比'],[82,'毛'],[83,'氏'],[84,'气'],[85,'水'],[86,'火'],[87,'爪'],[88,'父'],[89,'爻'],[90,'爿'],
  [91,'片'],[92,'牙'],[93,'牛'],[94,'犬'],[95,'玄'],[96,'玉'],[97,'瓜'],[98,'瓦'],[99,'甘'],[100,'生'],
  [101,'用'],[102,'田'],[103,'疋'],[104,'疒'],[105,'癶'],[106,'白'],[107,'皮'],[108,'皿'],[109,'目'],[110,'矛'],
  [111,'矢'],[112,'石'],[113,'示'],[114,'禸'],[115,'禾'],[116,'穴'],[117,'立'],[118,'竹'],[119,'米'],[120,'糸'],
  [121,'缶'],[122,'网'],[123,'羊'],[124,'羽'],[125,'老'],[126,'而'],[127,'耒'],[128,'耳'],[129,'聿'],[130,'肉'],
  [131,'臣'],[132,'自'],[133,'至'],[134,'臼'],[135,'舌'],[136,'舛'],[137,'舟'],[138,'艮'],[139,'色'],[140,'艸'],
  [141,'虍'],[142,'虫'],[143,'血'],[144,'行'],[145,'衣'],[146,'襾'],[147,'見'],[148,'角'],[149,'言'],[150,'谷'],
  [151,'豆'],[152,'豕'],[153,'豸'],[154,'貝'],[155,'赤'],[156,'走'],[157,'足'],[158,'身'],[159,'車'],[160,'辛'],
  [161,'辰'],[162,'辵'],[163,'邑'],[164,'酉'],[165,'釆'],[166,'里'],[167,'金'],[168,'長'],[169,'門'],[170,'阜'],
  [171,'隶'],[172,'隹'],[173,'雨'],[174,'靑'],[175,'非'],[176,'面'],[177,'革'],[178,'韋'],[179,'韭'],[180,'音'],
  [181,'頁'],[182,'風'],[183,'飛'],[184,'食'],[185,'首'],[186,'香'],[187,'馬'],[188,'骨'],[189,'高'],[190,'髟'],
  [191,'鬥'],[192,'鬯'],[193,'鬲'],[194,'鬼'],[195,'魚'],[196,'鳥'],[197,'鹵'],[198,'鹿'],[199,'麥'],[200,'麻'],
  [201,'黃'],[202,'黍'],[203,'黑'],[204,'黹'],[205,'黽'],[206,'鼎'],[207,'鼓'],[208,'鼠'],[209,'鼻'],[210,'齊'],
  [211,'齒'],[212,'龍'],[213,'龜'],[214,'龠'],
].map(([number, char]) => [number, RADICAL_NUMBER_TO_CHAR_OVERRIDES[number] || char]);

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const unihanRadicalMap = loadJson(path.join(BACKEND_DATA_DIR, '_unihan-radical-map.json'));
  const kanjiEn = loadJson(path.join(BACKEND_DATA_DIR, 'kanji-en.json'));
  const kanjiViArray = loadJson(path.join(FRONTEND_DATA_DIR, 'kanjiData.json'));

  const hvMap = new Map();
  for (const [char, hanviet, , , nghia] of kanjiViArray) {
    hvMap.set(char, { hanviet: hanviet || null, nghia: Array.isArray(nghia) ? nghia : [] });
  }

  // Build radicals.json
  const radicals = RADICAL_NUMBER_TO_CHAR.map(([number, char]) => {
    const info = kanjiEn[char];
    const vi = hvMap.get(char);
    if (!info) {
      throw new Error(`Radical ${number} (${char}) not found in kanji-en.json - add an override`);
    }
    return {
      number,
      char,
      strokes: info.strokes ?? null,
      hanViet: vi?.hanviet || null,
      meaningVi: vi?.nghia?.[0]?.replace(/\[.*?\]\s*/g, '') || null,
      meaningEn: info.meanings?.[0] || null,
      readingOn: info.readings_on || [],
      readingKun: info.readings_kun || [],
    };
  });

  if (radicals.length !== 214) {
    throw new Error(`Expected 214 radicals, got ${radicals.length}`);
  }

  // Merge `radical` field into kanji-en.json entries
  let matched = 0;
  const updatedKanjiEn = {};
  for (const [char, info] of Object.entries(kanjiEn)) {
    const radicalNumber = unihanRadicalMap[char] ?? null;
    if (radicalNumber != null) matched += 1;
    updatedKanjiEn[char] = { ...info, radical: radicalNumber };
  }

  const originalCount = Object.keys(kanjiEn).length;
  const updatedCount = Object.keys(updatedKanjiEn).length;
  if (updatedCount !== originalCount) {
    throw new Error(`Entry count changed: ${originalCount} -> ${updatedCount}`);
  }

  // Spot checks
  const spotChecks = { '一': 1, '木': 75, '水': 85 };
  for (const [char, expected] of Object.entries(spotChecks)) {
    const actual = updatedKanjiEn[char]?.radical;
    if (actual !== expected) {
      throw new Error(`Spot check failed for ${char}: expected radical ${expected}, got ${actual}`);
    }
  }

  const kanjiEnOut = JSON.stringify(updatedKanjiEn);
  const radicalsOut = JSON.stringify(radicals, null, 2);

  fs.writeFileSync(path.join(BACKEND_DATA_DIR, 'kanji-en.json'), kanjiEnOut);
  fs.writeFileSync(path.join(FRONTEND_DATA_DIR, 'kanji-en.json'), kanjiEnOut);
  fs.writeFileSync(path.join(BACKEND_DATA_DIR, 'radicals.json'), radicalsOut);
  fs.writeFileSync(path.join(FRONTEND_DATA_DIR, 'radicals.json'), radicalsOut);

  console.log(`kanji-en.json: ${updatedCount} entries, ${matched} matched to a radical (${((matched / updatedCount) * 100).toFixed(1)}%)`);
  console.log(`radicals.json: ${radicals.length} radicals written`);
  console.log('Sample radical 75:', radicals.find((r) => r.number === 75));
}

main();
