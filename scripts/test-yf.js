import yahooFinance from 'yahoo-finance2';
import * as yf from 'yahoo-finance2';
console.log('yf keys:', Object.keys(yf));
console.log('Has yf.default?', !!yf.default);
if (yf.default) console.log('yf.default keys:', Object.keys(yf.default || {}));
