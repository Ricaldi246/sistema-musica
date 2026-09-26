const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'frontend')));

const dbFile = path.join(__dirname, 'backend', 'database.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error("Error al conectar con la base de datos:", err.message);
    } else {
        console.log("Conectado a la Base de Datos SQL exitosamente 🗄️");
    }
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS instrumentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        tipo TEXT NOT NULL,
        numero_serie TEXT UNIQUE NOT NULL,
        estado_fisico TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS prestamos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instrumento_id INTEGER,
        solicitante TEXT NOT NULL,
        ci_solicitante TEXT,
        clase_evento TEXT NOT NULL,
        fecha_prestamo TEXT NOT NULL,
        fecha_devolucion_limite TEXT NOT NULL,
        firma_digital TEXT,
        estado TEXT DEFAULT 'Activo',
        multa REAL DEFAULT 0,
        FOREIGN KEY(instrumento_id) REFERENCES instrumentos(id)
    )`, () => {
        db.run(`ALTER TABLE prestamos ADD COLUMN ci_solicitante TEXT`, () => {});
        db.run(`ALTER TABLE prestamos ADD COLUMN firma_digital TEXT`, () => {});
    });
});

// --- API INSTRUMENTOS ---
app.post('/api/instrumentos', (req, res) => {
    const { nombre, tipo, numero_serie, estado_fisico } = req.body;
    const query = `INSERT INTO instrumentos (nombre, tipo, numero_serie, estado_fisico) VALUES (?, ?, ?, ?)`;
    db.run(query, [nombre, tipo, numero_serie, estado_fisico], function(err) {
        if (err) return res.status(400).json({ error: "El número de serie ya existe." });
        res.json({ mensaje: "Registrado con éxito", id: this.lastID });
    });
});

app.get('/api/instrumentos', (req, res) => {
    db.all(`SELECT * FROM instrumentos`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.put('/api/instrumentos/:id', (req, res) => {
    const { estado_fisico } = req.body;
    db.run(`UPDATE instrumentos SET estado_fisico = ? WHERE id = ?`, [estado_fisico, req.params.id], function(err) {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ mensaje: "Estado actualizado" });
    });
});

app.delete('/api/instrumentos/:id', (req, res) => {
    db.run(`DELETE FROM instrumentos WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ mensaje: "Eliminado con éxito" });
    });
});

// --- API PRESTAMOS Y SANCIONES ---
app.get('/api/prestamos', (req, res) => {
    const query = `
        SELECT prestamos.id, prestamos.solicitante, prestamos.ci_solicitante, prestamos.clase_evento, 
               prestamos.fecha_prestamo, prestamos.fecha_devolucion_limite, 
               prestamos.firma_digital, prestamos.estado, prestamos.multa,
               instrumentos.nombre, instrumentos.numero_serie 
        FROM prestamos 
        LEFT JOIN instrumentos ON prestamos.instrumento_id = instrumentos.id
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/prestamos', (req, res) => {
    const { instrumento_id, solicitante, ci_solicitante, clase_evento, fecha_prestamo, fecha_devolucion_limite, firma_digital } = req.body;
    
    if (!instrumento_id || !solicitante || !fecha_prestamo || !fecha_devolucion_limite) {
        return res.status(400).json({ error: "Faltan campos obligatorios" });
    }

    const query = `INSERT INTO prestamos (instrumento_id, solicitante, ci_solicitante, clase_evento, fecha_prestamo, fecha_devolucion_limite, firma_digital, estado, multa) VALUES (?, ?, ?, ?, ?, ?, ?, 'Activo', 0)`;
    db.run(query, [instrumento_id, solicitante, ci_solicitante || '', clase_evento || 'General', fecha_prestamo, fecha_devolucion_limite, firma_digital], function(err) {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ mensaje: "Préstamo registrado", id: this.lastID });
    });
});

app.put('/api/prestamos/:id/devolver', (req, res) => {
    const { id } = req.params;
    const { fecha_devolucion_real, estado_fisico_retorno } = req.body;

    db.get(`SELECT * FROM prestamos WHERE id = ?`, [id], (err, prestamo) => {
        if (err || !prestamo) return res.status(404).json({ error: "Préstamo no encontrado" });

        let multaTotal = 0;
        const fechaLimite = new Date(prestamo.fecha_devolucion_limite).getTime();
        const fechaReal = new Date(fecha_devolucion_real).getTime();
        const diferenciaMilisegundos = fechaReal - fechaLimite;

        if (diferenciaMilisegundos > 0) {
            const segundosRetraso = Math.floor(diferenciaMilisegundos / 1000);
            multaTotal += segundosRetraso * 0.01;
        }

        if (estado_fisico_retorno === 'Desgaste regular') {
            multaTotal += 15;
        } else if (estado_fisico_retorno === 'En reparación') {
            multaTotal += 50;
        }

        db.run(`UPDATE prestamos SET estado = 'Devuelto', multa = ? WHERE id = ?`, [multaTotal, id], function(err2) {
            if (err2) return res.status(400).json({ error: err2.message });

            db.run(`UPDATE instrumentos SET estado_fisico = ? WHERE id = ?`, [estado_fisico_retorno, prestamo.instrumento_id], function() {
                res.json({ mensaje: "Devolución registrada con éxito", multa: multaTotal });
            });
        });
    });
});

app.get('/api/estado', (req, res) => {
    res.json({ mensaje: "El servidor y la Base de Datos SQL están funcionando 🎵" });
});

app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});