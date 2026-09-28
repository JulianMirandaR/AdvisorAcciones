// Servicio para obtener datos desde Firebase (Los datos son actualizados diariamente por el backend / GitHub Actions)
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc, collection, getDocs } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";
import { mockStocks, mockMacro, mockCclHistory, mockHealth } from "./devFixtures.js";

// --- DETECCIÓN DE ENTORNO LOCAL ---
// En localhost (o file://) no tenemos acceso a la config del backend por CORS ni permisos de
// Firestore, así que la app entera se caía al cargar. En ese caso activamos un "modo mock" que
// sirve datos de ejemplo (devFixtures.js) para poder ver y desarrollar la UI sin la nube.
// En producción (Vercel / GitHub Pages) IS_MOCK es false y todo funciona como siempre.
const isLocalDev = (typeof location !== 'undefined') && (
    ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ||
    (location.hostname && (location.hostname.endsWith('.localhost') || location.hostname.endsWith('.test'))) ||
    location.protocol === 'file:'
);
export const IS_MOCK = isLocalDev;

let firebaseConfig;
if (!IS_MOCK) {
    // Obtener configuración de Firebase desde el backend para evitar exponer claves en el código
    const configResponse = await fetch('https://advisoraccionesbackend-production.up.railway.app/api/ai/config');
    firebaseConfig = await configResponse.json();
} else {
    // Config placeholder: solo sirve para que initializeApp/getAuth no exploten (varios módulos
    // usan `auth` al cargar). Nunca se usa contra el backend real: en modo mock las lecturas de
    // datos se cortan antes y devuelven las fixtures.
    firebaseConfig = { apiKey: 'dev-mock', authDomain: 'localhost', projectId: 'dev-mock', appId: '1:0:web:dev' };
    console.warn('%c[DEV] Modo mock activo: datos de EJEMPLO, sin nube. No usar para operar.', 'color:#eab308;font-weight:bold;font-size:13px');
}

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
            // Intentar obtener los datos de hoy, si no, los de ayer, hasta 7 días atrás
            // para no requerir un índice compuesto o descendente en __name__ que rompe la app.
            // Cada acción vive en su propio documento dentro de "stocks/{fecha}/symbols/{simbolo}"
            // (antes era un solo documento con las ~60 acciones como campos, lo que chocaba
            // contra el límite de 1MiB de Firestore y hacía que algunas dejaran de guardarse).
            for (let i = 0; i < 7; i++) {
                const d = new Date();
                d.setUTCDate(d.getUTCDate() - i);
                const dateStr = d.toISOString().split('T')[0];

                const symbolsSnap = await getDocs(collection(this.db, "stocks", dateStr, "symbols"));

                if (!symbolsSnap.empty) {
                    // Registrar la fecha real de los datos y cuántos días de antigüedad tiene,
                    // para poder avisar al usuario si está operando con datos viejos.
                    this.lastDocDate = dateStr;
                    this.lastDocAgeDays = i;
                    const stocksDataMap = {};
                    symbolsSnap.forEach(symbolDoc => { stocksDataMap[symbolDoc.id] = symbolDoc.data(); });
                    return stocksDataMap;
                }
            }
            return null;
        } catch (e) {
            throw e;
        }
    }

    // Método principal: Carga desde Firebase
    async loadStocks(onStockLoaded, onProgressMsg) {
        // Modo mock (desarrollo local): datos de ejemplo, sin tocar la nube.
        if (IS_MOCK) {
            window.dataDateStr = new Date().toISOString().split('T')[0];
            window.dataAgeDays = 0;
            const list = mockStocks();
            onStockLoaded(list);
            if (onProgressMsg) onProgressMsg("🧪 Modo DEMO local: mostrando datos de ejemplo (sin nube).");
            return;
        }
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
            // Exponer la fecha/antigüedad real del dato para la UI.
            window.dataDateStr = this.lastDocDate || null;
            window.dataAgeDays = (typeof this.lastDocAgeDays === 'number') ? this.lastDocAgeDays : null;

            const mergedList = Object.values(firestoreData).map(stockData => {
                if (stockData.history && typeof stockData.history === 'string') {
                    try { stockData.history = JSON.parse(stockData.history); } catch (e) {}
                }
                return stockData;
            });
            onStockLoaded(mergedList);
            if (onProgressMsg) {
                const ageMsg = window.dataAgeDays > 0
                    ? ` ⚠️ Datos de hace ${window.dataAgeDays} día(s) (${this.lastDocDate}).`
                    : ` (${this.lastDocDate}).`;
                onProgressMsg(`Datos de mercado cargados${ageMsg}`);
            }
        } else {
            console.log("No data in Firestore yet.");
            if (onProgressMsg) onProgressMsg("No hay datos en la nube. Esperando actualización del servidor.");
        }
    }

    // Método para cargar datos Macro (Indicador Buffett)
    async loadMacroIndicator(onMacroLoaded) {
        if (IS_MOCK) { onMacroLoaded(mockMacro()); return; }
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

    // Método para cargar el estado de salud de la última sincronización (1 sola lectura).
    // El backend escribe "meta/health" al final de cada corrida de update-data.js.
    async loadHealth(onHealthLoaded) {
        if (IS_MOCK) { onHealthLoaded(mockHealth()); return; }
        try {
            const docRef = doc(this.db, "meta", "health");
            const docSnap = await getDoc(docRef);
            if (docSnap.exists()) {
                onHealthLoaded(docSnap.data());
            }
        } catch (e) {
            console.error("Firestore Health Read Error:", e);
        }
    }

    // Método para cargar historial de CCL
    async loadCclHistory(onHistoryLoaded) {
        if (IS_MOCK) { onHistoryLoaded(mockCclHistory()); return; }
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
