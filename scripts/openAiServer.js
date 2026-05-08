import express from 'express';
import cors from 'cors';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc, getDoc, collection, query, orderBy, limit, getDocs } from "firebase/firestore";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const firebaseConfig = {
    apiKey: "AIzaSyC7bIZOsDhg0iXGrm6aBD3c37AD3ZkUmTE",
    authDomain: "advisoracciones.firebaseapp.com",
    projectId: "advisoracciones",
    storageBucket: "advisoracciones.firebasestorage.app",
    messagingSenderId: "454193425218",
    appId: "1:454193425218:web:54b7136d042ecd951876db",
    measurementId: "G-7KQ8CF2SXJ"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Endpoint para analizar una acción usando OpenAI
app.post('/api/ai/analyze', async (req, res) => {
    try {
        const { symbol, stockData } = req.body;

        if (!symbol || !stockData) {
            return res.status(400).json({ error: 'Falta el symbol o stockData en la petición.' });
        }

        // Obtener historial de trades exitosos/fallidos de este símbolo desde la DB para dar contexto a la IA
        const historyRef = collection(db, "trade_history");
        const q = query(historyRef, orderBy("date", "desc"), limit(5));
        const historySnapshot = await getDocs(q);
        let pastTradesContext = "Historial reciente de operaciones del bot:\n";
        historySnapshot.forEach(doc => {
            const data = doc.data();
            if(data.symbol === symbol) {
                pastTradesContext += `- Trade: ${data.action} | Precio: ${data.price} | Profit: ${data.profitPct}% | Resultado: ${data.profitPct > 0 ? 'Éxito' : 'Fracaso'}\n`;
            }
        });

        // Prompt enriquecido
        const systemPrompt = `
Eres un bot analista de trading experto. Tu objetivo es predecir si una acción va a subir o bajar a corto/mediano plazo basándote en análisis técnico, indicadores, noticias y el contexto de mercado.
Devuelve tu respuesta ÚNICAMENTE en formato JSON válido con esta estructura exacta:
{
    "probability": <número decimal entre 0 y 1>,
    "confidence": <número entero entre 0 y 100>,
    "bias": <"BULLISH", "BEARISH" o "NEUTRAL">,
    "thought": <"Texto de 2 o 3 oraciones justificando tu decisión, mencionando los indicadores clave">
}
`;
        
        const userPrompt = `
Analiza la siguiente acción: ${symbol}
Precio actual: $${stockData.price}
Cambio: ${stockData.changePercent}%
RSI: ${stockData.rsi}
MACD: ${stockData.macd ? stockData.macd.histogram : 'N/A'}
SMA50: ${stockData.sma50}
SMA200: ${stockData.sma200}
Volumen: ${stockData.volume}
ATR: ${stockData.atr}
Sentimiento de Noticias: ${stockData.newsSentimentStr} (Puntaje: ${stockData.newsSentiment})

${pastTradesContext}

¿Cuál es tu análisis?
`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o", // O "gpt-3.5-turbo" según la preferencia de costo
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            response_format: { type: "json_object" },
            temperature: 0.2
        });

        const resultText = response.choices[0].message.content;
        const resultJson = JSON.parse(resultText);

        res.json(resultJson);

    } catch (error) {
        console.error("OpenAI Error:", error);
        res.status(500).json({ error: 'Hubo un error al procesar el análisis con la IA.' });
    }
});

// Endpoint para guardar el resultado de un trade y que la IA aprenda (feedback loop)
app.post('/api/ai/feedback', async (req, res) => {
    try {
        const { symbol, action, price, profitPct, date } = req.body;
        
        if(!symbol || !action || price === undefined) {
            return res.status(400).json({ error: 'Faltan campos obligatorios' });
        }

        const tradeRef = doc(collection(db, "trade_history"));
        await setDoc(tradeRef, {
            symbol,
            action, // "BUY", "SELL", "STOP_LOSS", "TAKE_PROFIT"
            price,
            profitPct: profitPct || 0,
            date: date || new Date().toISOString()
        });

        res.json({ success: true, message: "Feedback guardado exitosamente." });
    } catch (error) {
        console.error("Feedback Error:", error);
        res.status(500).json({ error: 'Hubo un error al guardar el feedback.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor de OpenAI corriendo en el puerto ${PORT}`);
});
