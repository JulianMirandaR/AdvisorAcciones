// Configuración de ESLint (flat config) para el frontend.
// El proyecto corre en el navegador con ES modules y usa varias librerías cargadas por <script>
// o import por URL (Chart.js, LightweightCharts, TradingView, technicalindicators, Firebase),
// por eso las declaramos como globals de solo lectura para que no salten como "no definidas".
import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        ignores: ['node_modules/**', 'package-lock.json']
    },
    js.configs.recommended,
    {
        files: ['**/*.js', '**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                // Librerías externas (script tags / import por URL) y entorno
                tf: 'readonly',
                Chart: 'readonly',
                LightweightCharts: 'readonly',
                TradingView: 'readonly',
                technicalindicators: 'readonly',
                firebase: 'readonly',
                process: 'readonly'
            }
        },
        rules: {
            // Ruido bajo, no rompe el build: avisos en vez de errores.
            'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-console': 'off',
            // Inicializadores redundantes (default que siempre se reasigna) y try/catch que solo
            // re-lanza: son code-smell, no bugs. Los dejamos como aviso para no bloquear el CI.
            'no-useless-assignment': 'warn',
            'no-useless-catch': 'warn',
            // Mantenemos como ERROR lo que sí atrapa bugs reales.
            'no-constant-condition': ['error', { checkLoops: false }]
        }
    },
    {
        // Tests corren en Node.
        files: ['test/**/*.mjs'],
        languageOptions: {
            globals: { ...globals.node }
        }
    }
];
