const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { JSDOM } = require('jsdom');
const { TextDecoder, TextEncoder } = require('util');
const iconv = require('iconv-lite');
const jschardet = require('jschardet');

// --- Constants & Helpers ---

const unescapeHTML = str => {
    if (!str) return '';
    // JSDOM specific implementation
    const dom = new JSDOM('');
    const doc = dom.window.document;
    const textarea = doc.createElement('textarea');
    textarea.innerHTML = str;
    return textarea.value;
};

const MIME = {
    XML: 'application/xml',
    XHTML: 'application/xhtml+xml',
    HTML: 'text/html',
    CSS: 'text/css',
    SVG: 'image/svg+xml',
};

const PDB_HEADER = {
    name: [0, 32, 'string'],
    type: [60, 4, 'string'],
    creator: [64, 4, 'string'],
    numRecords: [76, 2, 'uint'],
};

const PALMDOC_HEADER = {
    compression: [0, 2, 'uint'],
    numTextRecords: [8, 2, 'uint'],
    recordSize: [10, 2, 'uint'],
    encryption: [12, 2, 'uint'],
};

const MOBI_HEADER = {
    magic: [16, 4, 'string'],
    length: [20, 4, 'uint'],
    type: [24, 4, 'uint'],
    encoding: [28, 4, 'uint'],
    uid: [32, 4, 'uint'],
    version: [36, 4, 'uint'],
    titleOffset: [84, 4, 'uint'],
    titleLength: [88, 4, 'uint'],
    localeRegion: [94, 1, 'uint'],
    localeLanguage: [95, 1, 'uint'],
    resourceStart: [108, 4, 'uint'],
    huffcdic: [112, 4, 'uint'],
    numHuffcdic: [116, 4, 'uint'],
    exthFlag: [128, 4, 'uint'],
    trailingFlags: [240, 4, 'uint'],
    indx: [244, 4, 'uint'],
};

const KF8_HEADER = {
    resourceStart: [108, 4, 'uint'],
    fdst: [192, 4, 'uint'],
    numFdst: [196, 4, 'uint'],
    frag: [248, 4, 'uint'],
    skel: [252, 4, 'uint'],
    guide: [260, 4, 'uint'],
};

const EXTH_HEADER = {
    magic: [0, 4, 'string'],
    length: [4, 4, 'uint'],
    count: [8, 4, 'uint'],
};

const INDX_HEADER = {
    magic: [0, 4, 'string'],
    length: [4, 4, 'uint'],
    type: [8, 4, 'uint'],
    idxt: [20, 4, 'uint'],
    numRecords: [24, 4, 'uint'],
    encoding: [28, 4, 'uint'],
    language: [32, 4, 'uint'],
    total: [36, 4, 'uint'],
    ordt: [40, 4, 'uint'],
    ligt: [44, 4, 'uint'],
    numLigt: [48, 4, 'uint'],
    numCncx: [52, 4, 'uint'],
};

const TAGX_HEADER = {
    magic: [0, 4, 'string'],
    length: [4, 4, 'uint'],
    numControlBytes: [8, 4, 'uint'],
};

const HUFF_HEADER = {
    magic: [0, 4, 'string'],
    offset1: [8, 4, 'uint'],
    offset2: [12, 4, 'uint'],
};

const CDIC_HEADER = {
    magic: [0, 4, 'string'],
    length: [4, 4, 'uint'],
    numEntries: [8, 4, 'uint'],
    codeLength: [12, 4, 'uint'],
};

const FDST_HEADER = {
    magic: [0, 4, 'string'],
    numEntries: [8, 4, 'uint'],
};

const FONT_HEADER = {
    flags: [8, 4, 'uint'],
    dataStart: [12, 4, 'uint'],
    keyLength: [16, 4, 'uint'],
    keyStart: [20, 4, 'uint'],
};

const MOBI_ENCODING = {
    1252: 'windows-1252',
    65001: 'utf-8',
};

const EXTH_RECORD_TYPE = {
    100: ['creator', 'string', true],
    101: ['publisher'],
    103: ['description'],
    104: ['isbn'],
    105: ['subject', 'string', true],
    106: ['date'],
    108: ['contributor', 'string', true],
    109: ['rights'],
    110: ['subjectCode', 'string', true],
    112: ['source', 'string', true],
    113: ['asin'],
    121: ['boundary', 'uint'],
    122: ['fixedLayout'],
    125: ['numResources', 'uint'],
    126: ['originalResolution'],
    127: ['zeroGutter'],
    128: ['zeroMargin'],
    129: ['coverURI'],
    132: ['regionMagnification'],
    201: ['coverOffset', 'uint'],
    202: ['thumbnailOffset', 'uint'],
    503: ['title'],
    524: ['language', 'string', true],
    527: ['pageProgressionDirection'],
};

const MOBI_LANG = {
    1: ['ar', 'ar-SA', 'ar-IQ', 'ar-EG', 'ar-LY', 'ar-DZ', 'ar-MA', 'ar-TN', 'ar-OM',
        'ar-YE', 'ar-SY', 'ar-JO', 'ar-LB', 'ar-KW', 'ar-AE', 'ar-BH', 'ar-QA'],
    2: ['bg'], 3: ['ca'], 4: ['zh', 'zh-TW', 'zh-CN', 'zh-HK', 'zh-SG'], 5: ['cs'],
    6: ['da'], 7: ['de', 'de-DE', 'de-CH', 'de-AT', 'de-LU', 'de-LI'], 8: ['el'],
    9: ['en', 'en-US', 'en-GB', 'en-AU', 'en-CA', 'en-NZ', 'en-IE', 'en-ZA',
        'en-JM', null, 'en-BZ', 'en-TT', 'en-ZW', 'en-PH'],
    10: ['es', 'es-ES', 'es-MX', null, 'es-GT', 'es-CR', 'es-PA', 'es-DO',
        'es-VE', 'es-CO', 'es-PE', 'es-AR', 'es-EC', 'es-CL', 'es-UY', 'es-PY',
        'es-BO', 'es-SV', 'es-HN', 'es-NI', 'es-PR'],
    11: ['fi'], 12: ['fr', 'fr-FR', 'fr-BE', 'fr-CA', 'fr-CH', 'fr-LU', 'fr-MC'],
    13: ['he'], 14: ['hu'], 15: ['is'], 16: ['it', 'it-IT', 'it-CH'],
    17: ['ja'], 18: ['ko'], 19: ['nl', 'nl-NL', 'nl-BE'], 20: ['no', 'nb', 'nn'],
    21: ['pl'], 22: ['pt', 'pt-BR', 'pt-PT'], 23: ['rm'], 24: ['ro'], 25: ['ru'],
    26: ['hr', null, 'sr'], 27: ['sk'], 28: ['sq'], 29: ['sv', 'sv-SE', 'sv-FI'],
    30: ['th'], 31: ['tr'], 32: ['ur'], 33: ['id'], 34: ['uk'], 35: ['be'],
    36: ['sl'], 37: ['et'], 38: ['lv'], 39: ['lt'], 41: ['fa'], 42: ['vi'],
    43: ['hy'], 44: ['az'], 45: ['eu'], 46: ['hsb'], 47: ['mk'], 48: ['st'],
    49: ['ts'], 50: ['tn'], 52: ['xh'], 53: ['zu'], 54: ['af'], 55: ['ka'],
    56: ['fo'], 57: ['hi'], 58: ['mt'], 59: ['se'], 62: ['ms'], 63: ['kk'],
    65: ['sw'], 67: ['uz', null, 'uz-UZ'], 68: ['tt'], 69: ['bn'], 70: ['pa'],
    71: ['gu'], 72: ['or'], 73: ['ta'], 74: ['te'], 75: ['kn'], 76: ['ml'],
    77: ['as'], 78: ['mr'], 79: ['sa'], 82: ['cy', 'cy-GB'], 83: ['gl', 'gl-ES'],
    87: ['kok'], 97: ['ne'], 98: ['fy'],
};

const concatTypedArray = (a, b) => {
    const result = new a.constructor(a.length + b.length);
    result.set(a);
    result.set(b, a.length);
    return result;
};
const concatTypedArray3 = (a, b, c) => {
    const result = new a.constructor(a.length + b.length + c.length);
    result.set(a);
    result.set(b, a.length);
    result.set(c, a.length + b.length);
    return result;
};

const decoder = new TextDecoder();
const getString = buffer => decoder.decode(buffer);
const getUint = buffer => {
    if (!buffer) return;
    const l = buffer.byteLength;
    const func = l === 4 ? 'getUint32' : l === 2 ? 'getUint16' : 'getUint8';
    return new DataView(buffer.buffer || buffer, buffer.byteOffset ?? 0, buffer.byteLength)[func](0);
};
const getStruct = (def, buffer) => Object.fromEntries(Array.from(Object.entries(def))
    .map(([key, [start, len, type]]) => [key,
        (type === 'string' ? getString : getUint)(buffer.slice(start, start + len))]));

const normalizeEncoding = encoding => {
    if (!encoding) return null;
    const enc = String(encoding).toLowerCase();
    if (enc === 'iso-8859-1') return 'windows-1252';
    if (enc === 'latin1') return 'windows-1252';
    if (enc === 'ascii') return 'utf-8';
    return enc;
};

const decodeWithEncoding = (buffer, encoding) => {
    const enc = normalizeEncoding(encoding) || 'utf-8';
    if (enc === 'utf-8' || enc === 'utf8' || enc === 'windows-1252') {
        return new TextDecoder(enc === 'utf8' ? 'utf-8' : enc).decode(buffer);
    }
    if (iconv.encodingExists(enc)) {
        return iconv.decode(Buffer.from(buffer), enc);
    }
    return new TextDecoder().decode(buffer);
};

const analyzeDecoded = str => {
    if (!str) return { len: 0, replacement: 0, control: 0, cjk: 0 };
    const replacement = (str.match(/\uFFFD/g) || []).length;
    const control = (str.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
    const cjk = (str.match(/[\u4E00-\u9FFF]/g) || []).length;
    return { len: str.length, replacement, control, cjk };
};

const isBetterDecoded = (base, candidate) => {
    if (candidate.replacement < base.replacement) return true;
    if (candidate.replacement === base.replacement && candidate.control < base.control) return true;
    if (candidate.replacement === base.replacement && candidate.control === base.control && candidate.cjk > base.cjk) return true;
    return false;
};

const hasLikelyChineseMojibake = (str) => {
    if (!str || typeof str !== 'string') return false;
    const mojibakeChars = (str.match(/[\u0080-\u00FF]/g) || []).length;
    const cjk = (str.match(/[\u4E00-\u9FFF]/g) || []).length;
    return mojibakeChars >= 2 && cjk === 0;
};

const repairMojibake = (str) => {
    if (!str || typeof str !== 'string') return str;
    if (!hasLikelyChineseMojibake(str)) return str;
    try {
        const rawBuf = Buffer.from(str, 'latin1');
        const utf8Str = rawBuf.toString('utf8');
        const utf8Stats = analyzeDecoded(utf8Str);
        if (utf8Stats.cjk > 0 && utf8Stats.replacement === 0) {
            return utf8Str;
        }
        if (iconv.encodingExists('gb18030')) {
            const gbkStr = iconv.decode(rawBuf, 'gb18030');
            const gbkStats = analyzeDecoded(gbkStr);
            if (gbkStats.cjk > 0 && gbkStats.replacement === 0) {
                return gbkStr;
            }
        }
    } catch (e) {}
    return str;
};

const isPoorDecoded = stats => {
    if (!stats || !stats.len) return false;
    const replacementRate = stats.replacement / stats.len;
    const controlRate = stats.control / stats.len;
    return replacementRate > 0.01 || controlRate > 0.005;
};

const detectUtf16Encoding = buffer => {
    if (!buffer || buffer.length < 2) return null;
    if (buffer[0] === 0xFF && buffer[1] === 0xFE) return 'utf-16le';
    if (buffer[0] === 0xFE && buffer[1] === 0xFF) return 'utf-16be';
    let evenNull = 0;
    let oddNull = 0;
    const len = buffer.length;
    for (let i = 0; i < len; i++) {
        if (buffer[i] === 0x00) {
            if (i % 2 === 0) evenNull++;
            else oddNull++;
        }
    }
    const evenRatio = evenNull / len;
    const oddRatio = oddNull / len;
    if (evenRatio > 0.2 || oddRatio > 0.2) {
        return evenRatio > oddRatio ? 'utf-16be' : 'utf-16le';
    }
    return null;
};

const isValidUtf8 = buffer => {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        return true;
    } catch (e) {
        return false;
    }
};

const getDecoder = (encoding, language) => {
    const primaryEncoding = normalizeEncoding(MOBI_ENCODING[encoding] || encoding || 'utf-8');
    const lang = typeof language === 'string' ? language.toLowerCase() : '';
    return {
        decode: (input) => {
            const buffer = input instanceof Uint8Array ? input : new Uint8Array(input);
            if (isValidUtf8(buffer)) {
                try {
                    const utf8Str = new TextDecoder('utf-8').decode(buffer);
                    const utf8Stats = analyzeDecoded(utf8Str);
                    if (utf8Stats.cjk > 0 && utf8Stats.replacement === 0) {
                        return utf8Str;
                    }
                } catch (e) {}
            }

            let decoded = decodeWithEncoding(buffer, primaryEncoding);
            const baseStats = analyzeDecoded(decoded);
            const decodedLooksBad = isPoorDecoded(baseStats) || (primaryEncoding === 'windows-1252' && hasLikelyChineseMojibake(decoded));
            const detected = jschardet.detect(Buffer.from(buffer));
            const detectedEnc = normalizeEncoding(detected && detected.encoding);
            const confidence = detected && detected.confidence ? detected.confidence : 0;
            const candidateEncodings = [];
            const addCandidate = enc => {
                if (!enc) return;
                if (enc === primaryEncoding) return;
                if (!candidateEncodings.includes(enc)) candidateEncodings.push(enc);
            };
            if (detectedEnc && (confidence >= 0.6 || (decodedLooksBad && confidence >= 0.3))) {
                addCandidate(detectedEnc);
            }
            const utf16Enc = detectUtf16Encoding(buffer);
            if (utf16Enc) {
                addCandidate(utf16Enc);
            }
            if (primaryEncoding !== 'utf-8' && isValidUtf8(buffer)) {
                addCandidate('utf-8');
            }
            if (lang.startsWith('zh') || decodedLooksBad || primaryEncoding === 'windows-1252') {
                addCandidate('gb18030');
                addCandidate('gbk');
                addCandidate('big5');
                addCandidate('utf-8');
            }
            for (const enc of candidateEncodings) {
                if (!iconv.encodingExists(enc)) continue;
                const candidate = decodeWithEncoding(buffer, enc);
                const candidateStats = analyzeDecoded(candidate);
                if (isBetterDecoded(baseStats, candidateStats)) {
                    decoded = candidate;
                    baseStats.replacement = candidateStats.replacement;
                    baseStats.control = candidateStats.control;
                    baseStats.cjk = candidateStats.cjk;
                    baseStats.len = candidateStats.len;
                }
            }
            return repairMojibake(decoded);
        }
    };
};

const getVarLen = (byteArray, i = 0) => {
    let value = 0, length = 0;
    for (const byte of byteArray.subarray(i, i + 4)) {
        value = (value << 7) | (byte & 0b111_1111) >>> 0;
        length++;
        if (byte & 0b1000_0000) break;
    }
    return { value, length };
};

const getVarLenFromEnd = byteArray => {
    let value = 0;
    for (const byte of byteArray.subarray(-4)) {
        if (byte & 0b1000_0000) value = 0;
        value = (value << 7) | (byte & 0b111_1111);
    }
    return value;
};

const countBitsSet = x => {
    let count = 0;
    for (; x > 0; x = x >> 1) if ((x & 1) === 1) count++;
    return count;
};

const countUnsetEnd = x => {
    let count = 0;
    while ((x & 1) === 0) x = x >> 1, count++;
    return count;
};

const decompressPalmDOC = array => {
    let output = [];
    for (let i = 0; i < array.length; i++) {
        const byte = array[i];
        if (byte === 0) output.push(0);
        else if (byte <= 8)
            for (const x of array.subarray(i + 1, (i += byte) + 1))
                output.push(x);
        else if (byte <= 0b0111_1111) output.push(byte);
        else if (byte <= 0b1011_1111) {
            const bytes = (byte << 8) | array[i++ + 1];
            const distance = (bytes & 0b0011_1111_1111_1111) >>> 3;
            const length = (bytes & 0b111) + 3;
            for (let j = 0; j < length; j++)
                output.push(output[output.length - distance]);
        }
        else output.push(32, byte ^ 0b1000_0000);
    }
    return Uint8Array.from(output);
};

const read32Bits = (byteArray, from) => {
    const startByte = from >> 3;
    const end = from + 32;
    const endByte = end >> 3;
    let bits = 0n;
    for (let i = startByte; i <= endByte; i++)
        bits = bits << 8n | BigInt(byteArray[i] ?? 0);
    return (bits >> (8n - BigInt(end & 7))) & 0xffffffffn;
};

const huffcdic = async (mobi, loadRecord) => {
    const huffRecord = await loadRecord(mobi.huffcdic);
    const { magic, offset1, offset2 } = getStruct(HUFF_HEADER, huffRecord);
    if (magic !== 'HUFF') throw new Error('Invalid HUFF record');

    const table1 = Array.from({ length: 256 }, (_, i) => offset1 + i * 4)
        .map(offset => getUint(huffRecord.slice(offset, offset + 4)))
        .map(x => [x & 0b1000_0000, x & 0b1_1111, x >>> 8]);

    const table2 = [null].concat(Array.from({ length: 32 }, (_, i) => offset2 + i * 8)
        .map(offset => [
            getUint(huffRecord.slice(offset, offset + 4)),
            getUint(huffRecord.slice(offset + 4, offset + 8))]));

    const dictionary = [];
    for (let i = 1; i < mobi.numHuffcdic; i++) {
        const record = await loadRecord(mobi.huffcdic + i);
        const cdic = getStruct(CDIC_HEADER, record);
        if (cdic.magic !== 'CDIC') throw new Error('Invalid CDIC record');
        const n = Math.min(1 << cdic.codeLength, cdic.numEntries - dictionary.length);
        const buffer = record.slice(cdic.length);
        for (let i = 0; i < n; i++) {
            const offset = getUint(buffer.slice(i * 2, i * 2 + 2));
            const x = getUint(buffer.slice(offset, offset + 2));
            const length = x & 0x7fff;
            const decompressed = x & 0x8000;
            const value = new Uint8Array(
                buffer.slice(offset + 2, offset + 2 + length));
            dictionary.push([value, decompressed]);
        }
    }

    const decompress = byteArray => {
        let output = new Uint8Array();
        const bitLength = byteArray.byteLength * 8;
        for (let i = 0; i < bitLength;) {
            const bits = Number(read32Bits(byteArray, i));
            let [found, codeLength, value] = table1[bits >>> 24];
            if (!found) {
                while (bits >>> (32 - codeLength) < table2[codeLength][0])
                    codeLength += 1;
                value = table2[codeLength][1];
            }
            if ((i += codeLength) > bitLength) break;

            const code = value - (bits >>> (32 - codeLength));
            let [result, decompressed] = dictionary[code];
            if (!decompressed) {
                result = decompress(result);
                dictionary[code] = [result, true];
            }
            output = concatTypedArray(output, result);
        }
        return output;
    };
    return decompress;
};

const getIndexData = async (indxIndex, loadRecord, language) => {
    const indxRecord = await loadRecord(indxIndex);
    const indx = getStruct(INDX_HEADER, indxRecord);
    if (indx.magic !== 'INDX') throw new Error('Invalid INDX record');
    const decoder = getDecoder(indx.encoding, language);

    const tagxBuffer = indxRecord.slice(indx.length);
    const tagx = getStruct(TAGX_HEADER, tagxBuffer);
    if (tagx.magic !== 'TAGX') throw new Error('Invalid TAGX section');
    const numTags = (tagx.length - 12) / 4;
    const tagTable = Array.from({ length: numTags }, (_, i) =>
        new Uint8Array(tagxBuffer.slice(12 + i * 4, 12 + i * 4 + 4)));

    const cncx = {};
    let cncxRecordOffset = 0;
    for (let i = 0; i < indx.numCncx; i++) {
        const record = await loadRecord(indxIndex + indx.numRecords + i + 1);
        const array = new Uint8Array(record);
        for (let pos = 0; pos < array.byteLength;) {
            const index = pos;
            const { value, length } = getVarLen(array, pos);
            pos += length;
            const result = record.slice(pos, pos + value);
            pos += value;
            cncx[cncxRecordOffset + index] = decoder.decode(result);
        }
        cncxRecordOffset += 0x10000;
    }

    const table = [];
    for (let i = 0; i < indx.numRecords; i++) {
        const record = await loadRecord(indxIndex + 1 + i);
        const array = new Uint8Array(record);
        const indx = getStruct(INDX_HEADER, record);
        if (indx.magic !== 'INDX') throw new Error('Invalid INDX record');
        for (let j = 0; j < indx.numRecords; j++) {
            const offsetOffset = indx.idxt + 4 + 2 * j;
            const offset = getUint(record.slice(offsetOffset, offsetOffset + 2));

            const length = getUint(record.slice(offset, offset + 1));
            const name = getString(record.slice(offset + 1, offset + 1 + length));

            const tags = [];
            const startPos = offset + 1 + length;
            let controlByteIndex = 0;
            let pos = startPos + tagx.numControlBytes;
            for (const [tag, numValues, mask, end] of tagTable) {
                if (end & 1) {
                    controlByteIndex++;
                    continue;
                }
                const offset = startPos + controlByteIndex;
                const value = getUint(record.slice(offset, offset + 1)) & mask;
                if (value === mask) {
                    if (countBitsSet(mask) > 1) {
                        const { value, length } = getVarLen(array, pos);
                        tags.push([tag, null, value, numValues]);
                        pos += length;
                    } else tags.push([tag, 1, null, numValues]);
                } else tags.push([tag, value >> countUnsetEnd(mask), null, numValues]);
            }

            const tagMap = {};
            for (const [tag, valueCount, valueBytes, numValues] of tags) {
                const values = [];
                if (valueCount != null) {
                    for (let i = 0; i < valueCount * numValues; i++) {
                        const { value, length } = getVarLen(array, pos);
                        values.push(value);
                        pos += length;
                    }
                } else {
                    let count = 0;
                    while (count < valueBytes) {
                        const { value, length } = getVarLen(array, pos);
                        values.push(value);
                        pos += length;
                        count += length;
                    }
                }
                tagMap[tag] = values;
            }
            table.push({ name, tagMap });
        }
    }
    return { table, cncx };
};

const getNCX = async (indxIndex, loadRecord, language) => {
    const { table, cncx } = await getIndexData(indxIndex, loadRecord, language);
    const items = table.map(({ tagMap }, index) => ({
        index,
        offset: tagMap[1]?.[0],
        size: tagMap[2]?.[0],
        label: cncx[tagMap[3]] ?? '',
        headingLevel: tagMap[4]?.[0],
        pos: tagMap[6],
        parent: tagMap[21]?.[0],
        firstChild: tagMap[22]?.[0],
        lastChild: tagMap[23]?.[0],
    }));
    const getChildren = item => {
        if (item.firstChild == null) return item;
        item.children = items.filter(x => x.parent === item.index).map(getChildren);
        return item;
    };
    return items.filter(item => item.headingLevel === 0).map(getChildren);
};

const getEXTH = (buf, encoding, language) => {
    const { magic, count } = getStruct(EXTH_HEADER, buf);
    if (magic !== 'EXTH') throw new Error('Invalid EXTH header');
    const decoder = getDecoder(encoding, language);
    const results = {};
    let offset = 12;
    for (let i = 0; i < count; i++) {
        const type = getUint(buf.slice(offset, offset + 4));
        const length = getUint(buf.slice(offset + 4, offset + 8));
        if (type in EXTH_RECORD_TYPE) {
            const [name, typ, many] = EXTH_RECORD_TYPE[type];
            const data = buf.slice(offset + 8, offset + length);
            const value = typ === 'uint' ? getUint(data) : decoder.decode(data);
            if (many) {
                results[name] ??= [];
                results[name].push(value);
            } else results[name] = value;
        }
        offset += length;
    }
    return results;
};

const getFont = async (buf, unzlib) => {
    const { flags, dataStart, keyLength, keyStart } = getStruct(FONT_HEADER, buf);
    const array = new Uint8Array(buf.slice(dataStart));
    if (flags & 0b10) {
        const bytes = keyLength === 16 ? 1024 : 1040;
        const key = new Uint8Array(buf.slice(keyStart, keyStart + keyLength));
        const length = Math.min(bytes, array.length);
        for (var i = 0; i < length; i++) array[i] = array[i] ^ key[i % key.length];
    }
    if (flags & 1) try {
        return await unzlib(array);
    } catch (e) {
        console.warn(e);
        console.warn('Failed to decompress font');
    }
    return array;
};

// Node.js specific: File wrapper
class File {
    constructor(filepath) {
        this.filepath = filepath;
        this.fd = fs.openSync(filepath, 'r');
        this.size = fs.statSync(filepath).size;
    }
    
    // Mimic Blob.slice().arrayBuffer()
    async slice(start, end) {
        const length = end - start;
        const buffer = Buffer.alloc(length);
        await new Promise((resolve, reject) => {
            fs.read(this.fd, buffer, 0, length, start, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        return {
            arrayBuffer: () => Promise.resolve(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
        };
    }

    close() {
        if (this.fd) fs.closeSync(this.fd);
    }
}

class PDB {
    #file;
    #offsets;
    pdb;
    async open(file) {
        this.#file = file;
        const pdb = getStruct(PDB_HEADER, await (await file.slice(0, 78)).arrayBuffer());
        this.pdb = pdb;
        const buffer = await (await file.slice(78, 78 + pdb.numRecords * 8)).arrayBuffer();
        this.#offsets = Array.from({ length: pdb.numRecords },
            (_, i) => getUint(buffer.slice(i * 8, i * 8 + 4)))
            .map((x, i, a) => [x, a[i + 1]]);
    }
    loadRecord(index) {
        const offsets = this.#offsets[index];
        if (!offsets) throw new RangeError('Record index out of bounds');
        return this.#file.slice(...offsets).then(b => b.arrayBuffer());
    }
    async loadMagic(index) {
        const start = this.#offsets[index][0];
        return getString(await (await this.#file.slice(start, start + 4)).arrayBuffer());
    }
}

class MOBI extends PDB {
    #start = 0;
    #resourceStart;
    #decoder;
    #encoder;
    #decompress;
    #removeTrailingEntries;
    constructor({ unzlib }) {
        super();
        this.unzlib = unzlib;
    }
    async open(file) {
        await super.open(file);
        this.headers = this.#getHeaders(await super.loadRecord(0));
        this.#resourceStart = this.headers.mobi.resourceStart;
        let isKF8 = this.headers.mobi.version >= 8;
        if (!isKF8) {
            const boundary = this.headers.exth?.boundary;
            if (boundary < 0xffffffff) try {
                this.headers = this.#getHeaders(await super.loadRecord(boundary));
                this.#start = boundary;
                isKF8 = true;
            } catch (e) {
                console.warn(e);
                console.warn('Failed to open KF8; falling back to MOBI');
            }
        }
        await this.#setup();
        return isKF8 ? new KF8(this).init() : new MOBI6(this).init();
    }
    #getHeaders(buf) {
        const palmdoc = getStruct(PALMDOC_HEADER, buf);
        const mobi = getStruct(MOBI_HEADER, buf);
        if (mobi.magic !== 'MOBI') throw new Error('Missing MOBI header');

        const { titleOffset, titleLength, localeLanguage, localeRegion } = mobi;
        mobi.title = buf.slice(titleOffset, titleOffset + titleLength);
        const lang = MOBI_LANG[localeLanguage];
        mobi.language = lang?.[localeRegion >> 2] ?? lang?.[0];

        const exth = mobi.hasExth
            ? getEXTH(buf.slice(mobi.length + 16), mobi.encoding, mobi.language) : null;
        const kf8 = mobi.version >= 8 ? getStruct(KF8_HEADER, buf) : null;
        return { palmdoc, mobi, exth, kf8 };
    }
    async #setup() {
        const { palmdoc, mobi } = this.headers;
        if (palmdoc.encryption && palmdoc.encryption !== 0) {
            throw new Error('此文件受DRM保护，您无权阅读。');
        }
        this.#decoder = getDecoder(mobi.encoding, mobi.language);
        this.#encoder = new TextEncoder();

        const { compression } = palmdoc;
        this.#decompress = compression === 1 ? f => f
            : compression === 2 ? decompressPalmDOC
            : compression === 17480 ? await huffcdic(mobi, this.loadRecord.bind(this))
            : null;
        if (!this.#decompress) throw new Error('Unknown compression type');

        const { trailingFlags } = mobi;
        const multibyte = trailingFlags & 1;
        const numTrailingEntries = countBitsSet(trailingFlags >>> 1);
        this.#removeTrailingEntries = array => {
            for (let i = 0; i < numTrailingEntries; i++) {
                const length = getVarLenFromEnd(array);
                array = array.subarray(0, -length);
            }
            if (multibyte) {
                const length = (array[array.length - 1] & 0b11) + 1;
                array = array.subarray(0, -length);
            }
            return array;
        };
    }
    decode(...args) {
        return this.#decoder.decode(...args);
    }
    encode(...args) {
        return this.#encoder.encode(...args);
    }
    loadRecord(index) {
        return super.loadRecord(this.#start + index);
    }
    loadMagic(index) {
        return super.loadMagic(this.#start + index);
    }
    loadText(index) {
        return this.loadRecord(index + 1)
            .then(buf => new Uint8Array(buf))
            .then(this.#removeTrailingEntries)
            .then(this.#decompress);
    }
    async loadResource(index) {
        const buf = await super.loadRecord(this.#resourceStart + index);
        const magic = getString(buf.slice(0, 4));
        if (magic === 'FONT') return getFont(buf, this.unzlib);
        if (magic === 'VIDE' || magic === 'AUDI') return buf.slice(12);
        return buf;
    }
    getNCX() {
        const index = this.headers.mobi.indx;
        if (index < 0xffffffff) return getNCX(index, this.loadRecord.bind(this), this.headers.exth?.language || this.headers.mobi.language);
    }
    getMetadata() {
        const { mobi, exth } = this.headers;
        return {
            identifier: mobi.uid.toString(),
            title: unescapeHTML(repairMojibake(exth?.title || this.decode(mobi.title))),
            author: exth?.creator?.map(unescapeHTML).map(repairMojibake),
            publisher: unescapeHTML(exth?.publisher),
            language: exth?.language ?? mobi.language,
            published: exth?.date,
            description: unescapeHTML(exth?.description),
            subject: exth?.subject?.map(unescapeHTML),
            rights: unescapeHTML(exth?.rights),
            contributor: exth?.contributor,
        };
    }
    // ... getCover removed as we handle it differently
}

const mbpPagebreakRegex = /<\s*(?:mbp:)?pagebreak[^>]*>/gi;
const fileposRegex = /<[^<>]+filepos=['"]{0,1}(\d+)[^<>]*>/gi;

const getIndent = el => {
    let x = 0;
    while (el) {
        const parent = el.parentElement;
        if (parent) {
            const tag = parent.tagName.toLowerCase();
            if (tag === 'p') x += 1.5;
            else if (tag === 'blockquote') x += 2;
        }
        el = parent;
    }
    return x;
};

function rawBytesToString(uint8Array) {
    const chunkSize = 0x8000;
    let result = '';
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
        result += String.fromCharCode.apply(null, uint8Array.subarray(i, i + chunkSize));
    }
    return result;
}

class MOBI6 {
    // JSDOM setup
    constructor(mobi) {
        this.mobi = mobi;
        const dom = new JSDOM('');
        this.window = dom.window;
        this.parser = new this.window.DOMParser();
        this.serializer = new this.window.XMLSerializer();
    }
    
    #resourceCache = new Map();
    #textCache = new Map();
    #cache = new Map();
    #sections;
    #fileposList = [];
    #type = MIME.HTML;

    async init() {
        const recordBuffers = [];
        for (let i = 0; i < this.mobi.headers.palmdoc.numTextRecords; i++) {
            const buf = await this.mobi.loadText(i);
            recordBuffers.push(buf);
        }
        const totalLength = recordBuffers.reduce((sum, buf) => sum + buf.byteLength, 0);
        const array = new Uint8Array(totalLength);
        recordBuffers.reduce((offset, buf) => {
            array.set(new Uint8Array(buf), offset);
            return offset + buf.byteLength;
        }, 0);
        const str = rawBytesToString(array);

        this.#sections = [0]
            .concat(Array.from(str.matchAll(mbpPagebreakRegex), m => m.index))
            .map((start, i, a) => {
                const end = a[i + 1] ?? array.length;
                return { book: this, raw: array.subarray(start, end) };
            })
            .map((section, i, arr) => {
                section.start = arr[i - 1]?.end ?? 0;
                section.end = section.start + section.raw.byteLength;
                return section;
            });

        this.sections = this.#sections.map((section, index) => ({
            id: index,
            load: () => this.loadSection(section),
            createDocument: () => this.createDocument(section),
            size: section.end - section.start,
        }));

        try {
            this.landmarks = await this.getGuide();
            const tocHref = this.landmarks
                .find(({ type }) => type?.includes('toc'))?.href;
            if (tocHref) {
                const { index } = this.resolveHref(tocHref);
                const doc = await this.sections[index].createDocument();
                let lastItem;
                let lastLevel = 0;
                let lastIndent = 0;
                const lastLevelOfIndent = new Map();
                const lastParentOfLevel = new Map();
                this.toc = Array.from(doc.querySelectorAll('a[filepos]'))
                    .reduce((arr, a) => {
                        const indent = getIndent(a);
                        const item = {
                            label: a.textContent?.trim() ?? '',
                            href: `filepos:${a.getAttribute('filepos')}`,
                        };
                        const level = indent > lastIndent ? lastLevel + 1
                            : indent === lastIndent ? lastLevel
                            : lastLevelOfIndent.get(indent) ?? Math.max(0, lastLevel - 1);
                        if (level > lastLevel) {
                            if (lastItem) {
                                lastItem.subitems ??= [];
                                lastItem.subitems.push(item);
                                lastParentOfLevel.set(level, lastItem);
                            }
                            else arr.push(item);
                        }
                        else {
                            const parent = lastParentOfLevel.get(level);
                            if (parent) parent.subitems.push(item);
                            else arr.push(item);
                        }
                        lastItem = item;
                        lastLevel = level;
                        lastIndent = indent;
                        lastLevelOfIndent.set(indent, level);
                        return arr;
                    }, []);
            }
        } catch(e) {
            console.warn(e);
        }

        this.#fileposList = [...new Set(
            Array.from(str.matchAll(fileposRegex), m => m[1]))]
            .map(filepos => ({ filepos, number: Number(filepos) }))
            .sort((a, b) => a.number - b.number);

        this.metadata = this.mobi.getMetadata();
        return this;
    }

    async getGuide() {
        const doc = await this.createDocument(this.#sections[0]);
        return Array.from(doc.getElementsByTagName('reference'), ref => ({
            label: ref.getAttribute('title'),
            type: ref.getAttribute('type')?.split(/\s/),
            href: `filepos:${ref.getAttribute('filepos')}`,
        }));
    }

    async loadText(section) {
        if (this.#textCache.has(section)) return this.#textCache.get(section);
        const { raw } = section;

        const fileposList = this.#fileposList
            .filter(({ number }) => number >= section.start && number < section.end)
            .map(obj => ({ ...obj, offset: obj.number - section.start }));
        let arr = raw;
        if (fileposList.length) {
            arr = raw.subarray(0, fileposList[0].offset);
            fileposList.forEach(({ filepos, offset }, i) => {
                const next = fileposList[i + 1];
                const a = this.mobi.encode(`<a id="filepos${filepos}"></a>`);
                arr = concatTypedArray3(arr, a, raw.subarray(offset, next?.offset));
            });
        }
        const str = this.mobi.decode(arr).replace(mbpPagebreakRegex, '');
        this.#textCache.set(section, str);
        return str;
    }

    async createDocument(section) {
        const str = await this.loadText(section);
        return this.parser.parseFromString(str, this.#type);
    }

    async loadSection(section) {
        if (this.#cache.has(section)) return this.#cache.get(section);
        const doc = await this.createDocument(section);

        // Inject default styles
        const style = doc.createElement('style');
        doc.head.append(style);
        style.append(doc.createTextNode(`blockquote { margin-block-start: 0; margin-block-end: 0; margin-inline-start: 1em; margin-inline-end: 0; }`));

        // Process images
        // For MOBI6, images are resources.
        // We will rewrite src to special URI for extraction
        const images = doc.querySelectorAll('img');
        for (const img of images) {
            const recindex = img.getAttribute('recindex');
            if (recindex) {
                // Use custom URI scheme for extraction
                img.src = `recindex:${recindex}`;
            }
        }
        
        // Also process filepos links
        for (const a of doc.querySelectorAll('[filepos]')) {
             const filepos = a.getAttribute('filepos');
             a.href = `filepos:${filepos}`;
        }

        const result = this.serializer.serializeToString(doc);
        this.#cache.set(section, result);
        return result;
    }

    resolveHref(href) {
        const filepos = href.match(/filepos:(.*)/)[1];
        const number = Number(filepos);
        const index = this.#sections.findIndex(section => section.end > number);
        return { index };
    }
}

// handlers for `kindle:` uris
const kindleResourceRegex = /kindle:(flow|embed):(\w+)(?:\?mime=(\w+\/[-+.\w]+))?/;
const kindlePosRegex = /kindle:pos:fid:(\w+):off:(\w+)/;
const parsePosURI = str => {
    const [fid, off] = str.match(kindlePosRegex).slice(1);
    return { fid: parseInt(fid, 32), off: parseInt(off, 32) };
};
const makePosURI = (fid = 0, off = 0) =>
    `kindle:pos:fid:${fid.toString(32).toUpperCase().padStart(4, '0')
    }:off:${off.toString(32).toUpperCase().padStart(10, '0')}`;

const getFragmentSelector = str => {
    const match = str.match(/\s(id|name|aid)\s*=\s*['"]([^'"]*)['"]/i);
    if (!match) return;
    const [, attr, value] = match;
    // Need to escape properly for CSS selector
    return `[${attr}="${value.replace(/"/g, '\\"')}"]`;
};

class KF8 {
    constructor(mobi) {
        this.mobi = mobi;
        const dom = new JSDOM('');
        this.window = dom.window;
        this.parser = new this.window.DOMParser();
        this.serializer = new this.window.XMLSerializer();
    }
    
    #cache = new Map();
    #fragmentOffsets = new Map();
    #fragmentSelectors = new Map();
    #tables = {};
    #sections;
    #fullRawLength;
    #rawHead = new Uint8Array();
    #rawTail = new Uint8Array();
    #lastLoadedHead = -1;
    #lastLoadedTail = -1;
    #type = MIME.XHTML;

    async init() {
        const loadRecord = this.mobi.loadRecord.bind(this.mobi);
        const { kf8 } = this.mobi.headers;

        try {
            const fdstBuffer = await loadRecord(kf8.fdst);
            const fdst = getStruct(FDST_HEADER, fdstBuffer);
            if (fdst.magic !== 'FDST') throw new Error('Missing FDST record');
            const fdstTable = Array.from({ length: fdst.numEntries },
                (_, i) => 12 + i * 8)
                .map(offset => [
                    getUint(fdstBuffer.slice(offset, offset + 4)),
                    getUint(fdstBuffer.slice(offset + 4, offset + 8))]);
            this.#tables.fdstTable = fdstTable;
            this.#fullRawLength = fdstTable[fdstTable.length - 1][1];
        } catch {}

        const skelTable = (await getIndexData(kf8.skel, loadRecord)).table
            .map(({ name, tagMap }, index) => ({
                index, name,
                numFrag: tagMap[1][0],
                offset: tagMap[6][0],
                length: tagMap[6][1],
            }));
        const fragData = await getIndexData(kf8.frag, loadRecord);
        const fragTable = fragData.table.map(({ name, tagMap }) => ({
            insertOffset: parseInt(name),
            selector: fragData.cncx[tagMap[2][0]],
            index: tagMap[4][0],
            offset: tagMap[6][0],
            length: tagMap[6][1],
        }));
        this.#tables.skelTable = skelTable;
        this.#tables.fragTable = fragTable;

        this.#sections = skelTable.reduce((arr, skel) => {
            const last = arr[arr.length - 1];
            const fragStart = last?.fragEnd ?? 0, fragEnd = fragStart + skel.numFrag;
            const frags = fragTable.slice(fragStart, fragEnd);
            const length = skel.length + frags.map(f => f.length).reduce((a, b) => a + b, 0);
            const totalLength = (last?.totalLength ?? 0) + length;
            return arr.concat({ skel, frags, fragEnd, length, totalLength });
        }, []);

        this.sections = this.#sections.map((section, index) => ({
            id: index,
            load: () => this.loadSection(section),
            createDocument: () => this.createDocument(section),
            size: section.length,
        }));

        try {
            const ncx = await this.mobi.getNCX();
            const map = ({ label, pos, children }) => {
                const [fid, off] = pos;
                const href = makePosURI(fid, off);
                const arr = this.#fragmentOffsets.get(fid);
                if (arr) arr.push(off);
                else this.#fragmentOffsets.set(fid, [off]);
                return { label: unescapeHTML(label), href, subitems: children?.map(map) };
            };
            this.toc = ncx?.map(map);
            this.landmarks = await this.getGuide();
        } catch(e) {
            console.warn(e);
        }

        this.metadata = this.mobi.getMetadata();
        return this;
    }

    async getGuide() {
        const index = this.mobi.headers.kf8.guide;
        if (index < 0xffffffff) {
            const loadRecord = this.mobi.loadRecord.bind(this.mobi);
            const { table, cncx } = await getIndexData(index, loadRecord, this.mobi.headers.exth?.language || this.mobi.headers.mobi.language);
            return table.map(({ name, tagMap }) => ({
                label: cncx[tagMap[1][0]] ?? '',
                type: name?.split(/\s/),
                href: makePosURI(tagMap[6]?.[0] ?? tagMap[3]?.[0]),
            }));
        }
    }

    async loadRaw(start, end) {
        const distanceHead = end - this.#rawHead.length;
        const distanceEnd = this.#fullRawLength == null ? Infinity
            : (this.#fullRawLength - this.#rawTail.length) - start;
        
        if (distanceHead < 0 || distanceHead < distanceEnd) {
            while (this.#rawHead.length < end) {
                const index = ++this.#lastLoadedHead;
                const data = await this.mobi.loadText(index);
                this.#rawHead = concatTypedArray(this.#rawHead, data);
            }
            return this.#rawHead.slice(start, end);
        }
        
        while (this.#fullRawLength - this.#rawTail.length > start) {
            const index = this.mobi.headers.palmdoc.numTextRecords - 1
                - (++this.#lastLoadedTail);
            const data = await this.mobi.loadText(index);
            this.#rawTail = concatTypedArray(data, this.#rawTail);
        }
        const rawTailStart = this.#fullRawLength - this.#rawTail.length;
        return this.#rawTail.slice(start - rawTailStart, end - rawTailStart);
    }

    async loadText(section) {
        const { skel, frags, length } = section;
        const raw = await this.loadRaw(skel.offset, skel.offset + length);
        let skeleton = raw.slice(0, skel.length);
        for (const frag of frags) {
            const insertOffset = frag.insertOffset - skel.offset;
            const offset = skel.length + frag.offset;
            const fragRaw = raw.slice(offset, offset + frag.length);
            skeleton = concatTypedArray3(
                skeleton.slice(0, insertOffset), fragRaw,
                skeleton.slice(insertOffset));

            const offsets = this.#fragmentOffsets.get(frag.index);
            if (offsets) for (const offset of offsets) {
                const str = this.mobi.decode(fragRaw.slice(offset));
                const selector = getFragmentSelector(str);
                this.#setFragmentSelector(frag.index, offset, selector);
            }
        }
        return this.mobi.decode(skeleton);
    }

    async createDocument(section) {
        const str = await this.loadText(section);
        return this.parser.parseFromString(str, this.#type);
    }

    async loadSection(section) {
        if (this.#cache.has(section)) return this.#cache.get(section);
        const str = await this.loadText(section);
        
        // Rewrite resources to simple URIs for later extraction
        // In foliate-js, this calls replaceSeries and loads Blobs.
        // We will just simplify it to keep the kindle: scheme but maybe ensure it's clean
        // Actually, we don't need to do anything here if we handle kindle: in extractImage.
        // But let's look at `kindleResourceRegex`.
        // We want to ensure the img src is something we can pass to extractImage.
        
        // foliate-js replaceResources does:
        // str.replace(regex, (...args) => (matches.push(args), null))
        // then results.push(await f(...args))
        
        // We can't do async replace easily on string without splitting logic.
        // But we can parse to DOM and modify.
        
        let doc = this.parser.parseFromString(str, this.#type);
        if (doc.querySelector('parsererror') || !doc.documentElement?.namespaceURI) {
            this.#type = MIME.HTML;
            doc = this.parser.parseFromString(str, this.#type);
        }

        // Fix images
        // kindle:embed:xxxx?mime=...
        // We leave them as is or normalize them?
        // If we leave them as `kindle:embed:xxxx`, the frontend will see that src.
        // The backend `extractImage` will receive `kindle:embed:xxxx`.
        
        // However, we need to make sure the paths are URL safe if they go into query params.
        
        const result = this.serializer.serializeToString(doc);
        this.#cache.set(section, result);
        return result;
    }
    
    #setFragmentSelector(id, offset, selector) {
        const map = this.#fragmentSelectors.get(id);
        if (map) map.set(offset, selector);
        else {
            const map = new Map();
            this.#fragmentSelectors.set(id, map);
            map.set(offset, selector);
        }
    }

    getIndexByFID(fid) {
        return this.#sections.findIndex(section =>
            section.frags.some(frag => frag.index === fid));
    }
}

// --- Main Parser Interface ---

async function parseToc({ book }) {
    const file = new File(book.filepath);
    const mobi = new MOBI({ unzlib: (buf) => new Promise((resolve, reject) => zlib.inflate(buf, (err, res) => err ? reject(err) : resolve(res))) });
    
    try {
        const parser = await mobi.open(file);
        
        // Build map of section index -> title
        const titleMap = new Map();
        const traverse = (items) => {
            for (const item of items) {
                const mapped = mapTocItem(item, parser);
                if (mapped.index !== -1) {
                    if (titleMap.has(mapped.index)) {
                        titleMap.set(mapped.index, titleMap.get(mapped.index) + ' / ' + mapped.title);
                    } else {
                        titleMap.set(mapped.index, mapped.title);
                    }
                }
                if (item.subitems) traverse(item.subitems);
            }
        };
        
        if (parser.toc) traverse(parser.toc);
        
        // Flatten sections to match liteReader expectations
        const toc = parser.sections.map((sec, i) => ({
            title: titleMap.get(i) || `Chapter ${i + 1}`,
            id: i.toString(),
            index: i,
            is_toc_item: titleMap.has(i)
        }));
        
        return {
            type: 'complete',
            toc: toc,
            format: book.format,
            title: parser.metadata.title,
            author: parser.metadata.author ? parser.metadata.author.join(', ') : '',
            publisher: parser.metadata.publisher || '', // <--- 补上这一行！
            description: parser.metadata.description,
            cover: null // We don't extract cover here to keep it fast
        };

    } finally {
        file.close();
    }
}

function mapTocItem(item, parser) {
    // resolve href to section index
    let index = -1;
    
    if (parser instanceof MOBI6) {
        // href is filepos:xxxx
        const res = parser.resolveHref(item.href);
        if (res) index = res.index;
    } else if (parser instanceof KF8) {
        // href is kindle:pos:fid:xxxx:off:xxxx
        const match = item.href.match(/kindle:pos:fid:(\w+):off:(\w+)/);
        if (match) {
            const fid = parseInt(match[1], 32);
            index = parser.getIndexByFID(fid);
        }
    }
    
    return {
        title: repairMojibake(item.label),
        href: item.href,
        index: index,
        id: index.toString(),
        children: item.subitems ? item.subitems.map(i => mapTocItem(i, parser)) : []
    };
}

// We need a persistent way to access the parser for `loadChapter` and `extractImage`
// Since `liteReader` seems to be stateless between requests (except what's passed in params),
// we have to re-open the file.
// But `foliate-js` parses headers on open.
// This might be slightly slow but acceptable for backend.

async function loadChapter({ book, index }) {
    const file = new File(book.filepath);
    const mobi = new MOBI({ unzlib: (buf) => new Promise((resolve, reject) => zlib.inflate(buf, (err, res) => err ? reject(err) : resolve(res))) });
    try {
        const parser = await mobi.open(file);
        if (index < 0 || index >= parser.sections.length) throw new Error('Index out of bounds');
        const content = await parser.sections[index].load();
        return { content };
    } finally {
        file.close();
    }
}

async function extractImage({ book, imagePath, res }) {
    const file = new File(book.filepath);
    const mobi = new MOBI({ unzlib: (buf) => new Promise((resolve, reject) => zlib.inflate(buf, (err, res) => err ? reject(err) : resolve(res))) });
    try {
        const parser = await mobi.open(file);
        let bufferData;
        let mimeType = 'image/jpeg';
        
        // Ensure path is decoded
        imagePath = decodeURIComponent(imagePath);
        console.log(`[FoliateMobiParser] Extracting image: ${imagePath}`);

        // Handle kindle:embed:xxxx or recindex:xxxx
        if (imagePath.startsWith('recindex:')) {
            const recindex = imagePath.split(':')[1];
            // MOBI6
            const resourceIndex = Number(recindex) - 1;
            console.log(`[FoliateMobiParser] Loading MOBI6 resource index: ${resourceIndex} (from ${recindex})`);
            bufferData = await parser.mobi.loadResource(resourceIndex);
        } else if (imagePath.startsWith('kindle:embed:')) {
            // KF8
            // kindle:embed:xxxx?mime=...
            const match = imagePath.match(/kindle:embed:(\w+)(?:\?mime=(\w+\/[-+.\w]+))?/);
            if (match) {
                const id = parseInt(match[1], 32);
                console.log(`[FoliateMobiParser] Loading KF8 resource id: ${id} (index: ${id - 1})`);
                bufferData = await parser.mobi.loadResource(id - 1);
                if (match[2]) mimeType = match[2];
            }
        } else {
             // Try to parse as simple path (maybe from old parser logic)
             // or just filename
             console.log(`[FoliateMobiParser] Unknown image path format: ${imagePath}`);
        }

        if (bufferData) {
            const buffer = Buffer.from(bufferData);
            console.log(`[FoliateMobiParser] Image found, size: ${buffer.length}, type: ${mimeType}`);
            // Detect mime type if not known?
            // Simple check
            if (buffer[0] === 0xFF && buffer[1] === 0xD8) mimeType = 'image/jpeg';
            else if (buffer[0] === 0x89 && buffer[1] === 0x50) mimeType = 'image/png';
            else if (buffer[0] === 0x47 && buffer[1] === 0x49) mimeType = 'image/gif';
            
            res.setHeader('Content-Type', mimeType);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.send(buffer);
        } else {
            console.warn(`[FoliateMobiParser] Image not found for path: ${imagePath}`);
            res.status(404).send('Not Found');
        }
    } catch(e) {
        console.error(e);
        res.status(500).send(e.message);
    } finally {
        file.close();
    }
}

module.exports = {
    parseToc,
    loadChapter,
    extractImage,
    repairMojibake
};
