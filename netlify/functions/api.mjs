// Carga dinámica para soportar distintas versiones de @netlify/neon
// v0.1.x expone `Neon` (clase con .sql), versiones anteriores exponen `neon` (tagged template)

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
    creado_en timestamptz default now()
  )`;
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
    hizo_preventa text,
    estado_especifico text,
    creado_en timestamptz default now()
  )`;
}

export const handler = async (event) => {
  const { httpMethod, path } = event;
  const { resource, id, action } = parsePath(path);

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

    if (resource === 'proveedores') {
      if (httpMethod === 'GET') {
        const rows = await sql`select id, nombre from proveedores order by id desc`;
        return json(200, rows);
      }
      if (httpMethod === 'POST') {
        const body = JSON.parse(event.body || '{}');
        if (!body.nombre || String(body.nombre).trim().length < 2) {
          return json(400, { error: 'Nombre inválido' });
        }
        const rows = await sql`insert into proveedores(nombre) values(${String(body.nombre).trim()}) returning id, nombre`;
        return json(201, rows[0]);
      }
      if ((httpMethod === 'PATCH' || httpMethod === 'PUT') && id) {
        const body = JSON.parse(event.body || '{}');
        if (!body.nombre || String(body.nombre).trim().length < 2) {
          return json(400, { error: 'Nombre inválido' });
        }
        const rows = await sql`update proveedores set nombre = ${String(body.nombre).trim()} where id = ${id} returning id, nombre`;
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
        if (fecha) {
          const rows = await sql`select * from visitas where fecha = ${fecha} order by id desc`;
          return json(200, rows);
        }
        const rows = await sql`select * from visitas order by id desc`;
        return json(200, rows);
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
        const rows = await sql`insert into asistencias(visita_id, asistio, hizo_preventa, estado_especifico) values(${Number(visita_id)}, ${Number(asistio) ? 1 : 0}, ${hizo_preventa || null}, ${estado_especifico || null}) returning *`;
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
