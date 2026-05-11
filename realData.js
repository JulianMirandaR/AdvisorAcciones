// Servicio para obtener datos desde Firebase (Los datos son actualizados diariamente por el backend / GitHub Actions)
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";

// Obtener configuración de Firebase desde el backend para evitar exponer claves en el código
const configResponse = await fetch('https://advisoraccionesbackend-production.up.railway.app/api/ai/config');
const firebaseConfig = await configResponse.json();

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
        // 1. Ya no usamos localStorage para caché de mercado
        // 2. Obtener datos globales de Firebase (La nube)
        if (onProgressMsg) onProgressMsg("Sincronizando con la nube de precios...");

        let firestoreData = null;
        try {
            firestoreData = await this.getLatestFirestoreData();
        } catch (e) {
            console.error("Firestore Read Error:", e);
            if (onProgressMsg) onProgressMsg(`⚠️ Error de Conexión Nube: ${e.code || e.message}`);
        }

        if (firestoreData) {
            const mergedList = Object.values(firestoreData).map(stockData => {
                if (stockData.history && typeof stockData.history === 'string') {
                    try { stockData.history = JSON.parse(stockData.history); } catch (e) {}
                }
                return stockData;
            });
            onStockLoaded(mergedList);
            if (onProgressMsg) onProgressMsg("Datos de mercado actualizados exitosamente.");
        } else {
            console.log("No data in Firestore yet.");
            if (onProgressMsg) onProgressMsg("No hay datos en la nube. Esperando actualización del servidor.");
        }
    }

    // Método para cargar datos Macro (Indicador Buffett)
    async loadMacroIndicator(onMacroLoaded) {
        try {
            const docRef = doc(this.db, "macro", "latest");
            const docSnap = await getDoc(docRef);
            if (docSnap.exists()) {
                const data = docSnap.data();
                onMacroLoaded(data);
            }
        } catch (e) {
            console.error("Firestore Macro Read Error:", e);
        }
    }

    // Método para cargar historial de CCL
    async loadCclHistory(onHistoryLoaded) {
        try {
            const docRef = doc(this.db, "macro", "ccl_history");
            const docSnap = await getDoc(docRef);
            if (docSnap.exists()) {
                const data = docSnap.data();
                onHistoryLoaded(data);
            }
        } catch (e) {
            console.error("Firestore CCL History Read Error:", e);
        }
    }
}
