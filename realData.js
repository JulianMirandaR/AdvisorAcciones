// Servicio para obtener datos desde Firebase (Los datos son actualizados diariamente por el backend / GitHub Actions)
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";

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
export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

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
            // Intentar obtener el documento de hoy, si no, el de ayer, hasta 7 días atrás
            // para no requerir un índice compuesto o descendente en __name__ que rompe la app
            for (let i = 0; i < 7; i++) {
                const d = new Date();
                d.setUTCDate(d.getUTCDate() - i);
                const dateStr = d.toISOString().split('T')[0];

                const docRef = doc(this.db, "stocks", dateStr);
                const docSnap = await getDoc(docRef);

                if (docSnap.exists()) {
                    return docSnap.data();
                }
            }
            return null;
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
                if (stockData.history && typeof stockData.history === 'string') {
                    try { stockData.history = JSON.parse(stockData.history); } catch (e) {}
                }
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
                try {
                    // Limpiar cachés antiguos para liberar espacio en localStorage
                    const keysToRemove = [];
                    for (let i = 0; i < localStorage.length; i++) {
                        const key = localStorage.key(i);
                        if (key && key.startsWith('stocks_cache_') && key !== cacheKey) {
                            keysToRemove.push(key);
                        }
                    }
                    keysToRemove.forEach(k => localStorage.removeItem(k));

                    try {
                        localStorage.setItem(cacheKey, JSON.stringify(mergedList));
                    } catch (quotaExceededError) {
                        console.warn("Quota exceeded a pesar de limpiar. Guardando versión ligera sin historial completo.", quotaExceededError);
                        // Limpiar todos los datos pesados para que el localStorage pueda guardarlo
                        const lightList = mergedList.map(stock => {
                            const { history, ...rest } = stock;
                            // Dejamos al menos los últimos 6 precios en history ya que se usan para momentum (p1 y p5) en app.js
                            if (history && history.prices && history.prices.length >= 6) {
                                rest.history = { prices: history.prices.slice(-6) };
                            }
                            return rest;
                        });
                        localStorage.setItem(cacheKey, JSON.stringify(lightList));
                    }
                } catch (err) {
                    console.error("Error gestionando caché:", err);
                }
                
                onStockLoaded(mergedList);
            }
            if (onProgressMsg) onProgressMsg("Datos de mercado actualizados exitosamente.");
        } else {
            console.log("No data in Firestore yet.");
            if (onProgressMsg) onProgressMsg("No hay datos en la nube. Esperando actualización del servidor.");
        }
    }

    // Método para cargar datos Macro (Indicador Buffett)
    async loadMacroIndicator(onMacroLoaded) {
        const cacheKey = `macro_cache`;
        try {
            const currentCache = JSON.parse(localStorage.getItem(cacheKey) || 'null');
            if (currentCache) onMacroLoaded(currentCache);
        } catch (e) { console.error("Error reading macro cache", e); }

        try {
            const docRef = doc(this.db, "macro", "latest");
            const docSnap = await getDoc(docRef);
            if (docSnap.exists()) {
                const data = docSnap.data();
                localStorage.setItem(cacheKey, JSON.stringify(data));
                onMacroLoaded(data);
            }
        } catch (e) {
            console.error("Firestore Macro Read Error:", e);
        }
    }

    // Método para cargar historial de CCL
    async loadCclHistory(onHistoryLoaded) {
        const cacheKey = `ccl_history_cache`;
        try {
            const currentCache = JSON.parse(localStorage.getItem(cacheKey) || 'null');
            if (currentCache) onHistoryLoaded(currentCache);
        } catch (e) { console.error("Error reading CCL cache", e); }

        try {
            const docRef = doc(this.db, "macro", "ccl_history");
            const docSnap = await getDoc(docRef);
            if (docSnap.exists()) {
                const data = docSnap.data();
                localStorage.setItem(cacheKey, JSON.stringify(data));
                onHistoryLoaded(data);
            }
        } catch (e) {
            console.error("Firestore CCL History Read Error:", e);
        }
    }
}
