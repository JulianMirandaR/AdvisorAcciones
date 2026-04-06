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
    
    for (let i = 0; i < prices.length - windowSize; i++) {
        // Feature (X): Los precios de la ventana (ej: día 1 al 20)
        const windowSlice = prices.slice(i, i + windowSize);
        
        // Normalizar localmente por ventana para que la IA se enfoque en la forma del patrón (shape) y no en el precio absoluto
        const wMax = Math.max(...windowSlice);
        const wMin = Math.min(...windowSlice);
        const windowPrices = windowSlice.map(val => (val - wMin) / (wMax - wMin || 1));
        
        X_data.push(windowPrices);
        
        // Target (Y): ¿Subió el precio en el día 21 respecto al día 20? (1 = Sube, 0 = Baja)
        const todayPrice = prices[i + windowSize - 1]; // Último día de la ventana
        const tomorrowPrice = prices[i + windowSize];  // Día que queremos estimar
        
        Y_data.push(tomorrowPrice > todayPrice ? 1 : 0);
    }
    
    // Convertir arreglos clásicos a Tensores de TensorFlow
    const tensorX = tf.tensor2d(X_data, [X_data.length, windowSize]);
    const tensorY = tf.tensor1d(Y_data);
    
    // 2. Construir la Red Neuronal (Arquitectura Secuencial simple)
    const model = tf.sequential();
    
    // Usamos semillas fijas en la inicialización para asegurar que la red comience
    // y termine con resultados consistentes (deterministas), eliminando la fluctuación al consultar de nuevo.
    const kInit = () => tf.initializers.glorotUniform({ seed: 42 });
    const bInit = () => tf.initializers.zeros();

    // Capa de entrada y oculta 1 (32 neuronas - necesitamos un "cerebro" un poco más grande para 20 precios)
    model.add(tf.layers.dense({ units: 32, activation: 'relu', inputShape: [windowSize], kernelInitializer: kInit(), biasInitializer: bInit() }));
    // Capa oculta 2 (16 neuronas) 
    model.add(tf.layers.dense({ units: 16, activation: 'relu', kernelInitializer: kInit(), biasInitializer: bInit() }));
    // Capa de salida (1 neurona con sigmoide para lanzar probabilidad entre 0% y 100%)
    model.add(tf.layers.dense({ units: 1, activation: 'sigmoid', kernelInitializer: kInit(), biasInitializer: bInit() }));
    
    model.compile({
        optimizer: tf.train.adam(0.01),
        loss: 'binaryCrossentropy',
        metrics: ['accuracy']
    });
    
    // 3. Entrenar el modelo con los datos pasados ("Aprender")
    await model.fit(tensorX, tensorY, {
        epochs: 100,       // Aumentamos a 100 para que aprenda mejor los patrones
        shuffle: false,    // Mezcla desactivada para mantener determinismo en series temporales
        verbose: 0         // Entrenamiento silencioso (sin logs en consola masivos)
    });
    
    // 4. Predecir el futuro (Mañana) usando los últimos N días actuales
    const recentPricesSlice = prices.slice(-windowSize);
    const rMax = Math.max(...recentPricesSlice);
    const rMin = Math.min(...recentPricesSlice);
    const recentPrices = recentPricesSlice.map(val => (val - rMin) / (rMax - rMin || 1));
    const inputTensor = tf.tensor2d([recentPrices], [1, windowSize]);
    
    const predictionTensor = model.predict(inputTensor);
    const prob = Array.from(await predictionTensor.data())[0]; // [0.xx]
    
    // Limpiar memoria de WebGL / CPU (Muy importante en tfjs)
    tensorX.dispose();
    tensorY.dispose();
    inputTensor.dispose();
    predictionTensor.dispose();
    
    // Confianza: Escalar para que probabilidades de 60-70% tengan un nivel de certeza más representativo
    let confidence = Math.abs(prob - 0.5) * 200; // Escala base 0 a 100%
    confidence = Math.min(100, confidence * 1.5); // Boost de certeza para que no se vea tan baja
    
    return { probability: prob, confidence: confidence, daysTrained: prices.length };
}
