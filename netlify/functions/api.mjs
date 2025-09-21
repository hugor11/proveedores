// Carga dinámica para soportar distintas versiones de @netlify/neon
// v0.1.x expone `Neon` (clase con .sql), versiones anteriores exponen `neon` (tagged template)
const DB_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function parsePath(path) {
  const parts = path.replace(/^\/\.netlify\/functions\/api\/?|^\/api\/?/, '').split('/').filter(Boolean);
  const [resource, second] = parts;
  const id = second && /^\d+$/.test(second) ? Number(second) : undefined;
  const action = second && !/^\d+$/.test(second) ? second : undefined;
  return { resource, id, action };
}

async function getSql() {
  const mod = await import('@netlify/neon');
  const url = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
  if (mod.Neon) {
    if (!url) throw new Error('DATABASE_URL no definido');
    const client = new mod.Neon(url);
    return client.sql;
  }
  if (mod.neon) {
    return url ? mod.neon(url) : mod.neon();
  }
  throw new Error('Cliente @netlify/neon no disponible');
}

async function ensureSchema(sql) {
  await sql`create table if not exists proveedores (
    id serial primary key,
    nombre text not null,
    patron text,
    dias_semana text,
    cada_n integer,
    fecha_inicio date,
    tipo_visita text,
    creado_en timestamptz default now()
  )`;
  // Backfill columns in case table existed sin nuevas columnas
  await sql`alter table proveedores add column if not exists patron text`;
  await sql`alter table proveedores add column if not exists dias_semana text`;
  await sql`alter table proveedores add column if not exists cada_n integer`;
  await sql`alter table proveedores add column if not exists fecha_inicio date`;
  await sql`alter table proveedores add column if not exists tipo_visita text`;
  await sql`create table if not exists visitas (
    id serial primary key,
    proveedor_id integer not null references proveedores(id) on delete cascade,
    fecha date not null,
    tipoVisita text,
    creado_en timestamptz default now()
  )`;
  await sql`create table if not exists asistencias (
    id serial primary key,
    visita_id integer not null references visitas(id) on delete cascade,
    asistio integer not null default 0,
    hizo_preventa integer default 0,
    estado_especifico text,
    creado_en timestamptz default now()
  )`;
  
  // Migración: convertir hizo_preventa de text a integer si es necesario
  try {
    // Verificar si la columna ya es integer
    const colInfo = await sql`
      SELECT data_type 
      FROM information_schema.columns 
      WHERE table_name = 'asistencias' AND column_name = 'hizo_preventa'
    `;
    
    if (colInfo.length > 0 && colInfo[0].data_type === 'text') {
      console.log('Migrando hizo_preventa de text a integer...');
      
      // Actualizar valores text a integer
      await sql`UPDATE asistencias SET hizo_preventa = '1' WHERE hizo_preventa = 'true' OR hizo_preventa = '1'`;
      await sql`UPDATE asistencias SET hizo_preventa = '0' WHERE hizo_preventa IS NULL OR hizo_preventa = 'false' OR hizo_preventa = '0' OR hizo_preventa = ''`;
      
      // Cambiar tipo de columna
      await sql`ALTER TABLE asistencias ALTER COLUMN hizo_preventa TYPE integer USING COALESCE(NULLIF(hizo_preventa, '')::integer, 0)`;
      await sql`ALTER TABLE asistencias ALTER COLUMN hizo_preventa SET DEFAULT 0`;
      
      console.log('Migración completada');
    }
  } catch (e) {
    console.warn('Error en migración de hizo_preventa:', e.message);
  }
}

export const handler = async (event) => {
  const { httpMethod, path } = event;
  const { resource, id, action } = parsePath(path);

  // Soporte de rutas por pathname como en la guía del usuario
  try {
    const url = new URL(event.rawUrl || 'http://x');
    const pathname = url.pathname || '';
    if (pathname.endsWith('/api/health') || pathname.endsWith('/health')) {
      return json(200, { ok: true });
    }
    if (pathname.endsWith('/api/dbhealth') || pathname.endsWith('/dbhealth')) {
      if (!DB_URL) return json(500, { ok: false, error: 'DATABASE_URL no definido' });
      const sql = await getSql();
      // Asegurar tablas y probar conectividad real
      await ensureSchema(sql);
      try {
        const prov = await sql`select count(*)::int as count from proveedores`;
        const vis = await sql`select count(*)::int as count from visitas`;
        const asi = await sql`select count(*)::int as count from asistencias`;
        return json(200, { ok: true, proveedores: prov[0].count, visitas: vis[0].count, asistencias: asi[0].count });
      } catch (e) {
        return json(500, { ok: false, error: e.message || 'DB error' });
      }
    }
  } catch {}

  if (resource === 'health') {
    return json(200, { ok: true, message: 'Netlify Functions up' });
  }

  let sql;
  try {
    sql = await getSql();
    await ensureSchema(sql);

    if (resource === 'dbhealth') {
      try {
        const prov = await sql`select count(*)::int as c from proveedores`;
        const vis = await sql`select count(*)::int as c from visitas`;
        const asi = await sql`select count(*)::int as c from asistencias`;
        return json(200, { ok: true, proveedores: prov[0].c, visitas: vis[0].c, asistencias: asi[0].c });
      } catch (e) {
        return json(500, { ok: false, error: e.message || 'DB error' });
      }
    }

    // Helpers para programación
    function parseDiasSemana(text) {
      try {
        const arr = JSON.parse(text || '[]');
        return Array.isArray(arr) ? arr.map(n => Number(n)) : [];
      } catch { return []; }
    }
    function daysBetween(aISO, bISO) {
      const a = new Date(`${aISO}T00:00:00`);
      const b = new Date(`${bISO}T00:00:00`);
      return Math.floor((b - a) / (24*3600*1000));
    }
    function shouldGenerateForDate(p, fechaISO) {
      const patron = (p.patron || '').toLowerCase();
      // Sin patrón no se genera: solo aparecen los programados
      if (!patron) return false;
      if (patron === 'daily') return true;
      if (patron === 'weekly') {
        const dias = parseDiasSemana(p.dias_semana);
        const dow = new Date(`${fechaISO}T00:00:00`).getDay(); // 0..6
        return dias.includes(dow);
      }
      if (patron === 'everyndays') {
        const n = Number(p.cada_n || 0);
        const start = p.fecha_inicio ? String(p.fecha_inicio) : null;
        if (!n || n < 2 || !start) return false;
        const diff = daysBetween(start, fechaISO);
        return diff >= 0 && diff % n === 0;
      }
      return false;
    }

    if (resource === 'proveedores') {
      if (httpMethod === 'GET') {
        const rows = await sql`select id, nombre, patron, dias_semana, cada_n, fecha_inicio, tipo_visita from proveedores order by id desc`;
        return json(200, rows);
      }
      if (httpMethod === 'POST') {
        const body = JSON.parse(event.body || '{}');
        if (!body.nombre || String(body.nombre).trim().length < 2) {
          return json(400, { error: 'Nombre inválido' });
        }
        const patron = (body.patron || '').toLowerCase();
        if (!patron || !['daily','weekly','everyndays'].includes(patron)) {
          return json(400, { error: 'patron requerido: daily|weekly|everyNDays' });
        }
        if (patron === 'weekly') {
          const dias = Array.isArray(body.diasSemana) ? body.diasSemana : [];
          if (!dias.length) return json(400, { error: 'diasSemana requerido para weekly' });
        }
        if (patron === 'everyndays') {
          const n = Number(body.cadaNDias || 0);
          if (!n || n < 2) return json(400, { error: 'cadaNDias >= 2 requerido' });
          if (!body.fechaInicio) return json(400, { error: 'fechaInicio requerido para everyNDays' });
        }
        const dias_semana = body.diasSemana ? JSON.stringify(body.diasSemana) : (body.dias_semana || null);
        const cada_n = body.cadaNDias || body.cada_n || null;
        const fecha_inicio = body.fechaInicio || body.fecha_inicio || null;
        const tipo_visita = body.tipoVisita || body.tipo_visita || null;
        const rows = await sql`insert into proveedores(nombre, patron, dias_semana, cada_n, fecha_inicio, tipo_visita)
          values(${String(body.nombre).trim()}, ${patron}, ${dias_semana}, ${cada_n}, ${fecha_inicio}, ${tipo_visita})
          returning id, nombre, patron, dias_semana, cada_n, fecha_inicio, tipo_visita`;
        return json(201, rows[0]);
      }
      if ((httpMethod === 'PATCH' || httpMethod === 'PUT') && id) {
        const body = JSON.parse(event.body || '{}');
        const currentRows = await sql`select id, nombre, patron, dias_semana, cada_n, fecha_inicio, tipo_visita from proveedores where id=${id}`;
        if (!currentRows.length) return json(404, { error: 'Proveedor no encontrado' });
        const current = currentRows[0];
        const updates = {
          nombre: body.nombre ?? current.nombre,
          patron: body.patron ?? current.patron,
          dias_semana: (body.diasSemana ? JSON.stringify(body.diasSemana) : (body.dias_semana ?? current.dias_semana)),
          cada_n: (body.cadaNDias ?? body.cada_n ?? current.cada_n),
          fecha_inicio: (body.fechaInicio ?? body.fecha_inicio ?? current.fecha_inicio),
          tipo_visita: (body.tipoVisita ?? body.tipo_visita ?? current.tipo_visita),
        };
        if (!updates.nombre || String(updates.nombre).trim().length < 2) return json(400, { error: 'Nombre inválido' });
        const pat = (updates.patron || '').toLowerCase();
        if (!pat || !['daily','weekly','everyndays'].includes(pat)) return json(400, { error: 'patron requerido: daily|weekly|everyNDays' });
        if (pat === 'weekly') {
          const dias = (()=>{ try{return JSON.parse(updates.dias_semana||'[]')}catch{return []} })();
          if (!Array.isArray(dias) || !dias.length) return json(400, { error: 'diasSemana requerido para weekly' });
        }
        if (pat === 'everyndays') {
          const n = Number(updates.cada_n || 0);
          if (!n || n < 2) return json(400, { error: 'cadaNDias >= 2 requerido' });
          if (!updates.fecha_inicio) return json(400, { error: 'fechaInicio requerido para everyNDays' });
        }
        const rows = await sql`update proveedores set 
            nombre = ${String(updates.nombre).trim()},
            patron = ${updates.patron || null},
            dias_semana = ${updates.dias_semana || null},
            cada_n = ${updates.cada_n || null},
            fecha_inicio = ${updates.fecha_inicio || null},
            tipo_visita = ${updates.tipo_visita || null}
          where id = ${id} returning id, nombre, patron, dias_semana, cada_n, fecha_inicio, tipo_visita`;
        if (!rows.length) return json(404, { error: 'Proveedor no encontrado' });
        return json(200, rows[0]);
      }
      if (httpMethod === 'DELETE' && id) {
        await sql`delete from proveedores where id = ${id}`;
        return json(204, {});
      }
      return json(405, { error: 'Método no permitido' });
    }

  if (resource === 'visitas') {
      if (httpMethod === 'GET') {
        const urlObj = new URL(event.rawUrl || 'http://x');
        const fecha = urlObj.searchParams.get('fecha');
        const autogen = urlObj.searchParams.get('autogen');
        if (fecha) {
          if (autogen) {
            // Generar visitas faltantes para la fecha según patrones de proveedores
            const proveedores = await sql`select id, patron, dias_semana, cada_n, fecha_inicio, tipo_visita from proveedores`;
            for (const p of proveedores) {
              if (!shouldGenerateForDate(p, fecha)) continue;
              const existe = await sql`select id from visitas where proveedor_id=${p.id} and fecha=${fecha} limit 1`;
              if (existe.length) continue;
              await sql`insert into visitas(proveedor_id, fecha, tipoVisita) values(${p.id}, ${fecha}, ${p.tipo_visita || 'Visita Normal'})`;
            }
          }
          const rows = await sql`select * from visitas where fecha = ${fecha} order by id desc`;
          return json(200, rows);
        }
        const rows = await sql`select * from visitas order by id desc`;
        return json(200, rows);
      }
      if ((httpMethod === 'PATCH' || httpMethod === 'PUT') && id) {
        const body = JSON.parse(event.body || '{}');
        const tipoVisita = body.tipoVisita;
        if (!tipoVisita || String(tipoVisita).trim().length === 0) return json(400, { error: 'tipoVisita requerido' });
        const rows = await sql`update visitas set tipoVisita=${tipoVisita} where id=${id} returning *`;
        if (!rows.length) return json(404, { error: 'Visita no encontrada' });
        return json(200, rows[0]);
      }
      if (httpMethod === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { proveedor_id, fecha, tipoVisita } = body;
        if (!proveedor_id || !fecha) return json(400, { error: 'proveedor_id y fecha son requeridos' });
        const rows = await sql`insert into visitas(proveedor_id, fecha, tipoVisita) values(${Number(proveedor_id)}, ${fecha}, ${tipoVisita || null}) returning *`;
        return json(201, rows[0]);
      }
      return json(405, { error: 'Método no permitido' });
    }

    if (resource === 'asistencias') {
      if (httpMethod === 'GET') {
        const rows = await sql`select * from asistencias order by id desc`;
        return json(200, rows);
      }
      if (httpMethod === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { visita_id, asistio, hizo_preventa, estado_especifico } = body;
        if (!visita_id) return json(400, { error: 'visita_id es requerido' });
        
        // Asegurar que hizo_preventa sea integer
        const hizoPreventaInt = hizo_preventa ? (Number(hizo_preventa) ? 1 : 0) : 0;
        
        const rows = await sql`
          insert into asistencias(visita_id, asistio, hizo_preventa, estado_especifico) 
          values(${Number(visita_id)}, ${Number(asistio) ? 1 : 0}, ${hizoPreventaInt}, ${estado_especifico || null}) 
          returning *
        `;
        return json(201, rows[0]);
      }
      return json(405, { error: 'Método no permitido' });
    }

    if (resource === 'admin') {
      if (httpMethod === 'GET' && action === 'export') {
        const proveedores = await sql`select * from proveedores order by id asc`;
        const visitas = await sql`select * from visitas order by id asc`;
        const asistencias = await sql`select * from asistencias order by id asc`;
        return json(200, { proveedores, visitas, asistencias, exportedAt: new Date().toISOString() });
      }
      if (httpMethod === 'POST' && action === 'import') {
        const body = JSON.parse(event.body || '{}');
        const { proveedores = [], visitas = [], asistencias = [] } = body;
        await sql`begin`;
        try {
          await sql`delete from asistencias`;
          await sql`delete from visitas`;
          await sql`delete from proveedores`;

          const provIdMap = new Map();
          for (const p of proveedores) {
            const rows = await sql`insert into proveedores(nombre) values(${p.nombre}) returning id`;
            provIdMap.set(p.id, rows[0].id);
          }

          const visitaIdMap = new Map();
          for (const v of visitas) {
            const newProvId = provIdMap.get(v.proveedor_id);
            if (!newProvId) continue;
            const rows = await sql`insert into visitas(proveedor_id, fecha, tipoVisita) values(${newProvId}, ${v.fecha}, ${v.tipoVisita || null}) returning id`;
            visitaIdMap.set(v.id, rows[0].id);
          }

          for (const a of asistencias) {
            const newVisId = visitaIdMap.get(a.visita_id);
            if (!newVisId) continue;
            await sql`insert into asistencias(visita_id, asistio, hizo_preventa, estado_especifico) values(${newVisId}, ${Number(a.asistio) ? 1 : 0}, ${a.hizo_preventa || null}, ${a.estado_especifico || null})`;
          }

          await sql`commit`;
          return json(200, { ok: true });
        } catch (e) {
          await sql`rollback`;
          throw e;
        }
      }
      return json(405, { error: 'Método o acción no permitidos' });
    }

    return json(404, { error: 'Ruta no encontrada' });
  } catch (err) {
    console.error('API error', err);
    return json(500, { error: err.message || 'Error interno' });
  }
};
