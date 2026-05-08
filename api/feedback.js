import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc, collection } from "firebase/firestore";

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

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { symbol, action, price, profitPct, date } = req.body;
        
        if(!symbol || !action || price === undefined) {
            return res.status(400).json({ error: 'Faltan campos obligatorios' });
        }

        const tradeRef = doc(collection(db, "trade_history"));
        await setDoc(tradeRef, {
            symbol,
            action,
            price,
            profitPct: profitPct || 0,
            date: date || new Date().toISOString()
        });

        res.status(200).json({ success: true, message: "Feedback guardado exitosamente." });
    } catch (error) {
        console.error("Feedback Error:", error);
        res.status(500).json({ error: 'Hubo un error al guardar el feedback.' });
    }
}
