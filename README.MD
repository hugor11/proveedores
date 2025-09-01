isabarrotes - Proveedores

Abarrotes y Carnicería Itzel - Gestión de proveedores y asistencias.

Despliegue en Netlify (Netlify Functions + Netlify DB/Postgres)

Este proyecto incluye una API serverless (/.netlify/functions/api) que guarda datos en Postgres usando @netlify/neon. La app web (index.html) llama a /api en el mismo dominio.

Variables de entorno requeridas

- NETLIFY_DATABASE_URL o DATABASE_URL: cadena de conexión a Postgres (Neon/Netlify DB, Supabase, etc.)
  Ejemplo: postgresql://USER:PASSWORD@HOST/DB?sslmode=require

Pasos de despliegue

1) Crear un sitio en Netlify y conectar este repo.
2) En Site settings > Environment variables agregar NETLIFY_DATABASE_URL (o DATABASE_URL) con tu cadena de conexión.
3) Deploy. Netlify publicará la función en /.netlify/functions/api/* con rutas amigables /api/*.

Desarrollo local

1) Instalar herramientas y deps:
	- npm i -g netlify-cli
	- npm i
2) Crear un archivo .env con NETLIFY_DATABASE_URL=...
3) Ejecutar: netlify dev
4) Abrir http://localhost:8888/

Rutas API

- GET /api/health -> estado
- GET /api/proveedores -> lista
- POST /api/proveedores { nombre }
- DELETE /api/proveedores/:id
- GET /api/visitas?fecha=YYYY-MM-DD o GET /api/visitas
- POST /api/visitas { proveedor_id, fecha, tipoVisita }
- GET /api/asistencias
- POST /api/asistencias { visita_id, asistio, hizo_preventa, estado_especifico }

