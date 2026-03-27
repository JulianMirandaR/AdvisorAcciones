// Módulo de Inteligencia Artificial (TensorFlow.js)
// Entrena un modelo neuronal pequeño al vuelo para predecir si el precio subirá mañana basándose en la historia reciente.

export async function runAIPrediction(stockData) {
    if (!window.tf) {
        return { error: "TensorFlow.js no está cargado en el navegador." };
    }
    
    // 1. Extraer precios del historial
    let prices = [];
    if (stockData.history && stockData.history.prices && Array.isArray(stockData.history.prices)) {
        prices = stockData.history.prices.map(p => parseFloat(p));
    }
    
    // Necesitamos suficientes datos para entrenar (Ej: mínimo 50 días para que el modelo tenga suficientes bloques de un mes para comparar)
    if (prices.length < 50) {
        return { error: `Datos históricos insuficientes para la IA. (Hay ${prices.length}, se necesitan +50 días para examinar patrones mensuales).` };
    }
    
    // Configuración de la "Memoria" de la IA: Mirará los últimos 20 días (1 mes de mercado) para predecir el día siguiente.
    const windowSize = 20;
    const X_data = [];
    const Y_data = [];
    
    // Normalizar precios (Llevarlos a un rango de 0 a 1) ayuda mucho a las Redes Neuronales
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);
    const normalize = (val) => (val - minPrice) / (maxPrice - minPrice || 1);
    
    for (let i = 0; i < prices.length - windowSize; i++) {
        // Feature (X): Los precios de la ventana (ej: día 1 al 5)
        const windowPrices = prices.slice(i, i + windowSize).map(normalize);
        X_data.push(windowPrices);
        
        // Target (Y): ¿Subió el precio en el día 6 respecto al día 5? (1 = Sube, 0 = Baja)
        const todayPrice = prices[i + windowSize - 1]; // Último día de la ventana
        const tomorrowPrice = prices[i + windowSize];  // Día que queremos estimar
        
        Y_data.push(tomorrowPrice > todayPrice ? 1 : 0);
    }
    
    // Convertir arreglos clásicos a Tensores de TensorFlow
    const tensorX = tf.tensor2d(X_data, [X_data.length, windowSize]);
    const tensorY = tf.tensor1d(Y_data);
    
    // 2. Construir la Red Neuronal (Arquitectura Secuencial simple)
    const model = tf.sequential();
    // Capa de entrada y oculta 1 (32 neuronas - necesitamos un "cerebro" un poco más grande para 20 precios)
    model.add(tf.layers.dense({ units: 32, activation: 'relu', inputShape: [windowSize] }));
    // Capa oculta 2 (16 neuronas) 
    model.add(tf.layers.dense({ units: 16, activation: 'relu' }));
    // Capa de salida (1 neurona con sigmoide para lanzar probabilidad entre 0% y 100%)
    model.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));
    
    model.compile({
        optimizer: tf.train.adam(0.01),
        loss: 'binaryCrossentropy',
        metrics: ['accuracy']
    });
    
    // 3. Entrenar el modelo con los datos pasados ("Aprender")
    await model.fit(tensorX, tensorY, {
        epochs: 40,        // Pasa por los datos 40 veces
        shuffle: true,     // Mezcla el orden para que no memorice
        verbose: 0         // Entrenamiento silencioso (sin logs en cónsola masivos)
    });
    
    // 4. Predecir el futuro (Mañana) usando los últimos N días actuales
    const recentPrices = prices.slice(-windowSize).map(normalize);
    const inputTensor = tf.tensor2d([recentPrices], [1, windowSize]);
    
    const predictionTensor = model.predict(inputTensor);
    const prob = Array.from(await predictionTensor.data())[0]; // [0.xx]
    
    // Limpiar memoria de WebGL / CPU (Muy importante en tfjs)
    tensorX.dispose();
    tensorY.dispose();
    inputTensor.dispose();
    predictionTensor.dispose();
    
    // Confianza: Si está en 0.5 (50%), no sabe. Si está cerca de 1.0 (100%) o 0.0 (0%), está muy seguro.
    const confidence = Math.abs(prob - 0.5) * 200; // Escala 0 a 100%
    
    return { probability: prob, confidence: confidence, daysTrained: prices.length };
}
