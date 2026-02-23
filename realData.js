// Servicio para obtener datos desde Firebase (Los datos son actualizados diariamente por el backend / GitHub Actions)
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getFirestore, collection, query, orderBy, limit, getDocs } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyC7bIZOsDhg0iXGrm6aBD3c37AD3ZkUmTE",
    authDomain: "advisoracciones.firebaseapp.com",
    projectId: "advisoracciones",
    storageBucket: "advisoracciones.firebasestorage.app",
    messagingSenderId: "454193425218",
    appId: "1:454193425218:web:54b7136d042ecd951876db",
    measurementId: "G-7KQ8CF2SXJ"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export class RealDataService {
    constructor() {
        this.db = db;
        this.limitReached = false;
    }

    getTodayDateString() {
        return new Date().toISOString().split('T')[0];
    }

    async getLatestFirestoreData() {
        try {
            // Obtenemos el último documento guardado en la colección "stocks" (ordenado por nombre que es la fecha 'YYYY-MM-DD')
            const q = query(collection(this.db, "stocks"), orderBy("__name__", "desc"), limit(1));
            const querySnapshot = await getDocs(q);

            if (!querySnapshot.empty) {
                return querySnapshot.docs[0].data(); // Returns object { AAPL: {...}, MSFT: {...} }
            } else {
                return null;
            }
        } catch (e) {
            throw e;
        }
    }

    // Método principal: Carga desde Firebase
    async loadStocks(onStockLoaded, onProgressMsg) {
        const today = this.getTodayDateString();
        const cacheKey = `stocks_cache_${today}`;

        // 1. Cargar lo que ya hay en caché (Local Storage para velocidad inicial)
        let currentCache = [];
        try {
            currentCache = JSON.parse(localStorage.getItem(cacheKey) || '[]');
        } catch (e) {
            console.error("Error reading cache", e);
            currentCache = [];
        }

        // Informar UI inicial con caché
        if (currentCache.length > 0) {
            onStockLoaded(currentCache);
        }

        // 2. Obtener datos globales de Firebase (La nube)
        if (onProgressMsg) onProgressMsg("Sincronizando con la nube de precios...");

        let firestoreData = null;
        try {
            firestoreData = await this.getLatestFirestoreData();
        } catch (e) {
            console.error("Firestore Read Error:", e);
            if (onProgressMsg) onProgressMsg(`⚠️ Error de Conexión Nube: ${e.code || e.message}`);
        }

        let mergedList = [...currentCache];
        const localMap = new Map(currentCache.map(s => [s.symbol, s]));

        if (firestoreData) {
            let changes = false;
            let loadedCount = 0;

            Object.values(firestoreData).forEach(stockData => {
                if (!localMap.has(stockData.symbol)) {
                    mergedList.push(stockData);
                    localMap.set(stockData.symbol, stockData);
                    changes = true;
                    loadedCount++;
                } else {
                    // Actualizamos si los datos de la nube son distintos al caché
                    const index = mergedList.findIndex(s => s.symbol === stockData.symbol);
                    if (index !== -1 && JSON.stringify(mergedList[index]) !== JSON.stringify(stockData)) {
                        mergedList[index] = stockData;
                        changes = true;
                        loadedCount++;
                    }
                }
            });

            if (changes || currentCache.length === 0) {
                localStorage.setItem(cacheKey, JSON.stringify(mergedList));
                onStockLoaded(mergedList);
            }
            if (onProgressMsg) onProgressMsg("Datos de mercado actualizados exitosamente.");
        } else {
            console.log("No data in Firestore yet.");
            if (onProgressMsg) onProgressMsg("No hay datos en la nube. Esperando actualización del servidor.");
        }
    }
}
