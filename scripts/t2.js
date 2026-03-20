import YahooFinanceClass from 'yahoo-finance2';
const yf = new YahooFinanceClass();
console.dir(yf, {depth: 2});
console.log('HAS historical:', typeof yf.historical);
