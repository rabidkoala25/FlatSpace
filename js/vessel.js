// vessel.js — a craft in flight: forces, torques, fuel, staging, landing, crashing.
(function () {
  const V = FS.vec;

  class Vessel {
    constructor(name, partIds, body, opts = {}) {
      this.name = name;
      this.parts = Array.isArray(partIds[0]) || typeof partIds[0] === 'string' ? FS.makeParts(partIds) : partIds;
      this.body = body;
      this.r = { x: body.R, y: 0 };
      this.v = { x: 0, y: 0 };
      this.angle = 0;
      this.omega = 0;
      this.throttle = opts.throttle ?? 0;
      this.isDebris = !!opts.debris;
      this.stages = this.isDebris ? [] : FS.stagesOf(this.parts);
      this.stageIdx = 0;
      this.sas = !this.isDebris;
      this.sasMode = 'stability';
      this.sasTarget = null;
      this.rot = 0;            // player rotation input, -1..1
      this.landed = null;      // {lon, rel} when resting on the ground
      this.splashed = false;
      this.dead = false;
      this.thrustNow = 0;
      this.thrustAccel = { x: 0, y: 0 };
      this.heat = 0;           // 0..1 reentry glow
      this.q = 0;              // dynamic pressure (Pa)
      this.age = 0;
      this.stats = { maxAlt: 0, maxSpeed: 0, launched: false };
      this.relayout();
    }

    relayout() {
      this.layout = FS.stackLayout(this.parts);
      this.mass = this.layout.mass;
      // centre of pressure: drag-area weighted position, fins count extra
      let w = 0, m = 0;
      this.parts.forEach((p, i) => {
        let chuteA = 0;
        if (p.chute === 'semi') chuteA = p.def.chute.semi * (p.deploy || 0);
        if (p.chute === 'full') chuteA = p.def.chute.semi + (p.def.chute.full - p.def.chute.semi) * Math.pow(p.deploy || 0, 2);
        const a = p.def.cda + (p.def.fin || 0) + chuteA;
        w += a; m += a * (this.layout.tops[i] + p.def.len / 2);
      });
      this.cda = w;
      this.cop = w > 0 ? m / w : this.layout.com;
      this.torqueWheel = this.parts.reduce((s, p) => s + (p.def.torque || 0), 0);
      this.hasCommand = this.parts.some((p) => p.def.command);
    }

    get nose() { return FS.vec.fromAngle(this.angle); }
    get altitude() { return V.len(this.r) - this.body.R; }
    // distance from centre of mass to the bottom / top along the rocket axis
    get bottomDist() { return this.layout.height - this.layout.com; }
    get topDist() { return this.layout.com; }

    placeOnPad(t) {
      const b = this.body;
      const lon = b.pad.lon;
      this.landed = { lon, rel: 0 };
      this.syncLanded(t);
    }

    syncLanded(t) {
      const b = this.body;
      const L = this.landed;
      const radAng = L.lon + FS.bodyRot(b, t);
      const ground = FS.surfaceHeight(b, L.lon);
      const rad = b.R + ground + this.bottomDist * Math.cos(L.rel) + 0.02;
      this.r = V.fromAngle(radAng, rad);
      this.v = FS.airVel(b, this.r);
      this.angle = radAng + L.rel;
      this.omega = b.omega;
    }

    // ---- Staging ----
    stage(game) {
      if (this.stageIdx >= this.stages.length) return null;
      const ev = this.stages[this.stageIdx++];
      if (ev.decouple) {
        const segs = FS.segmentsOf(this.parts);
        if (segs.length > 1) {
          const drop = segs[0];
          this.parts = this.parts.filter((p) => !drop.includes(p));
          const oldCom = this.layout.com;
          const oldTopPos = V.add(this.r, V.scale(this.nose, oldCom));
          this.relayout();
          // keep the upper part where it was
          const newR = V.sub(oldTopPos, V.scale(this.nose, this.layout.com));
          const deb = new Vessel('Debris', drop, this.body, { debris: true });
          const dropLayout = deb.layout;
          // debris CoM: its top starts where our stack ends
          const debTop = V.sub(newR, V.scale(this.nose, this.layout.height - this.layout.com));
          deb.r = V.sub(debTop, V.scale(this.nose, dropLayout.com + 0.05));
          deb.v = V.add(this.v, V.scale(this.nose, -1.5));
          deb.angle = this.angle;
          deb.omega = this.omega + (Math.random() - 0.5) * 0.05;
          deb.landed = null;
          this.r = newR;
          this.v = V.add(this.v, V.scale(this.nose, 0.6));
          if (game) game.addDebris(deb);
          if (this.landed) this.landed = null;
        }
      }
      if (ev.ignite) for (const p of ev.parts) if (p.def.engine && this.parts.includes(p)) p.lit = true;
      if (ev.chutes) for (const p of this.parts) if (p.chute === 'stowed') p.chute = 'armed';
      this.stats.launched = true;
      return ev;
    }

    deployChutes() {
      let any = false;
      for (const p of this.parts) if (p.chute === 'stowed') { p.chute = 'armed'; any = true; }
      return any;
    }

    // ---- Engines ----
    // Returns {F, mdot} totals and burns fuel if dt > 0.
    runEngines(dt, p) {
      const segs = FS.segmentsOf(this.parts);
      let F = 0;
      let anyLit = false, flame = false;
      this.nozzles = [];
      for (const seg of segs) {
        const liq = seg.filter((q) => q.lit && q.def.engine && !q.def.engine.solid);
        const tanks = seg.filter((q) => q.def.fuel);
        const fuel = tanks.reduce((s, q) => s + q.fuel, 0);
        if (liq.length) anyLit = true;
        if (liq.length && fuel > 0 && this.throttle > 0) {
          let mdot = 0, f = 0;
          for (const q of liq) { const t = FS.engineThrust(q.def.engine, p, this.throttle); mdot += t.mdot; f += t.F; }
          let frac = 1;
          if (dt > 0) {
            const want = mdot * dt;
            frac = Math.min(1, fuel / want);
            const used = want * frac;
            for (const tk of tanks) tk.fuel = Math.max(0, tk.fuel - used * (tk.fuel / fuel));
          }
          F += f * frac;
          for (const q of liq) this.nozzles.push({ part: q, power: this.throttle * frac });
          flame = true;
        }
        for (const q of seg) {
          if (q.lit && q.def.engine && q.def.engine.solid && q.solid > 0) {
            const t = FS.engineThrust(q.def.engine, p, 1);
            let frac = 1;
            if (dt > 0) { frac = Math.min(1, q.solid / (t.mdot * dt)); q.solid = Math.max(0, q.solid - t.mdot * dt * frac); }
            F += t.F * frac;
            this.nozzles.push({ part: q, power: frac, solid: true });
            flame = true;
          }
        }
      }
      this.flameout = anyLit && !flame && this.throttle > 0;
      return F;
    }

    gimbalTorque(F) {
      let tq = 0;
      this.parts.forEach((p, i) => {
        if (p.lit && p.def.engine && p.def.engine.gimbal) {
          const share = this.nozzles && this.nozzles.find((n) => n.part === p) ? 1 : 0;
          const lever = this.layout.tops[i] + p.def.len - this.layout.com;
          const thrustShare = this.thrustNow * share / Math.max(1, this.nozzles.length);
          tq += thrustShare * Math.sin((p.def.engine.gimbal * Math.PI) / 180) * lever;
        }
      });
      return tq;
    }

    sasTargetAngle(game) {
      const mode = this.sasMode;
      if (mode === 'stability') return this.sasTarget;
      const r = this.r;
      const surf = this.altitude < (this.body.atmo ? this.body.atmo.height * 0.5 : 10000);
      const vel = surf ? V.sub(this.v, FS.airVel(this.body, r)) : this.v;
      if (V.len(vel) < 0.5 && (mode === 'prograde' || mode === 'retrograde')) return this.sasTarget;
      const va = V.angle(vel);
      const ra = V.angle(r);
      switch (mode) {
        case 'prograde': return va;
        case 'retrograde': return va + Math.PI;
        case 'radialout': return ra;
        case 'radialin': return ra + Math.PI;
        case 'maneuver': {
          const nd = game && game.node;
          if (nd && nd.remaining && V.len(nd.remaining) > 0.01) return V.angle(nd.remaining);
          return this.sasTarget;
        }
      }
      return this.sasTarget;
    }

    // ---- Physics step ----
    step(dt, t, game) {
      if (this.dead) return;
      this.age += dt;
      const b = this.body;
      const p = FS.pressure(b, this.altitude);
      const rho = FS.density(b, this.altitude);

      // Parachute state machine
      let chuteChange = false;
      const agl = this.altitude - FS.surfaceHeight(b, FS.lonAt(b, V.angle(this.r), t));
      for (const q of this.parts) {
        if (q.chute === 'armed' && p > 0.04 && V.len(V.sub(this.v, FS.airVel(b, this.r))) < 300) { q.chute = 'semi'; q.deploy = 0; chuteChange = true; }
        if (q.chute === 'semi' && agl < 1000) { q.chute = 'full'; q.deploy = 0; chuteChange = true; }
        if ((q.chute === 'semi' || q.chute === 'full') && q.deploy < 1) q.deploy = Math.min(1, q.deploy + dt * 0.4);
      }
      if (chuteChange) this.relayout();

      // Engines
      const F = this.runEngines(dt, p);
      this.thrustNow = F;
      this.relayout();
      const m = this.mass;
      const n = this.nose;

      if (this.landed) {
        // Resting on the ground: lift off only if thrust beats weight.
        const up = V.norm(this.r);
        const g = b.mu / V.dot(this.r, this.r);
        if (F * V.dot(n, up) > m * g * 1.0001) {
          this.landed = null;
          this.splashed = false;
          this.r = V.add(this.r, V.scale(up, 0.05));
        } else {
          this.syncLanded(t);
          this.thrustAccel = { x: 0, y: 0 };
          return;
        }
      }

      // Forces
      const rlen = V.len(this.r);
      const gAcc = V.scale(this.r, -b.mu / (rlen * rlen * rlen));
      const vAir = V.sub(this.v, FS.airVel(b, this.r));
      const sAir = V.len(vAir);
      const q = 0.5 * rho * sAir * sAir;
      this.q = q;
      const dragF = q * this.cda;
      const dragVec = sAir > 1e-6 ? V.scale(vAir, -dragF / sAir) : { x: 0, y: 0 };
      const thrustVec = V.scale(n, F);
      this.thrustAccel = V.scale(thrustVec, 1 / m);
      const acc = V.add(gAcc, V.scale(V.add(thrustVec, dragVec), 1 / m));
      this.v = V.add(this.v, V.scale(acc, dt));
      this.r = V.add(this.r, V.scale(this.v, dt));
      this.gForce = V.len(V.sub(acc, gAcc)) / FS.G0;
      this.heat = FS.clamp((rho * sAir * sAir * sAir) / 6e7 - 0.1, 0, 1);

      // Torques (sub-stepped for stability with strong aero torques)
      const I = this.layout.I;
      const maxT = this.hasCommand ? this.torqueWheel + this.gimbalTorque(F) : 0;
      const copArm = this.layout.com - this.cop; // + toward nose
      const sub = 4;
      const h = dt / sub;
      for (let k = 0; k < sub; k++) {
        const nn = FS.vec.fromAngle(this.angle);
        let tau = 0;
        // aerodynamic torque from drag acting at the centre of pressure
        if (dragF > 0) {
          tau += V.cross(V.scale(nn, copArm), dragVec);
          tau -= 0.6 * q * this.cda * this.layout.height * this.layout.height * (this.omega) / Math.max(sAir, 5);
        }
        if (!this.isDebris && maxT > 0) {
          if (this.rot !== 0) {
            tau += this.rot * maxT;
            this.sasTarget = this.angle;
          } else if (this.sas) {
            let target = this.sasTargetAngle(game);
            if (target == null) { this.sasTarget = this.angle; target = this.angle; }
            const err = FS.wrapAngle(target - this.angle);
            const alphaMax = maxT / I;
            const wMax = Math.min(1.2, Math.sqrt(2 * alphaMax * Math.abs(err)) * 0.8);
            const wd = FS.clamp(err * 2.5, -wMax, wMax);
            tau += FS.clamp(I * (wd - this.omega) * 10, -maxT, maxT);
          }
        }
        this.omega += (tau / I) * h;
        this.omega = FS.clamp(this.omega, -12, 12);
        this.angle += this.omega * h;
      }
      this.angle = FS.wrapAngle(this.angle);

      // Stats
      const alt = this.altitude;
      if (b === FS.root) this.stats.maxAlt = Math.max(this.stats.maxAlt, alt);
      this.stats.maxSpeed = Math.max(this.stats.maxSpeed, V.len(this.v));

      this.checkGround(t, game);
      this.checkSOI(t, game);
    }

    checkGround(t, game) {
      const b = this.body;
      const n = this.nose;
      const ends = [
        { pt: V.sub(this.r, V.scale(n, this.bottomDist)), part: this.parts[this.parts.length - 1], bottom: true },
        { pt: V.add(this.r, V.scale(n, this.topDist)), part: this.parts[0], bottom: false },
      ];
      for (const e of ends) {
        const lon = FS.lonAt(b, V.angle(e.pt), t);
        const ground = FS.surfaceHeight(b, lon);
        const clear = V.len(e.pt) - b.R - ground;
        if (clear >= 0) continue;
        const vs = V.sub(this.v, FS.airVel(b, this.r));
        const speed = V.len(vs);
        const up = V.norm(this.r);
        const tilt = Math.acos(FS.clamp(V.dot(n, up), -1, 1));
        const water = b.ocean && FS.terrainHeight(b, lon) < 0;
        const tol = e.part ? e.part.def.crash : 8;
        if (this.isDebris) {
          if (speed > 12) { this.explode(game); return; }
        }
        if (water && speed < 20 && (tilt < 0.6 || tilt > Math.PI - 0.6 || speed < 8)) {
          this.setLanded(t, true, game); return;
        }
        if (!water && e.bottom && tilt < 0.5 && speed < tol) { this.setLanded(t, false, game); return; }
        if (!water && !e.bottom && tilt > Math.PI - 0.5 && speed < tol) { this.setLanded(t, false, game); return; }
        if (speed < 3) { this.setLanded(t, water, game); return; }
        this.explode(game);
        return;
      }
    }

    setLanded(t, water, game) {
      const b = this.body;
      const radAng = V.angle(this.r);
      const lon = FS.lonAt(b, radAng, t);
      // settle upright or upside-down, whichever is closer
      let rel = FS.wrapAngle(this.angle - radAng);
      if (Math.abs(rel) > Math.PI / 2) rel = Math.PI; else rel = 0;
      this.landed = { lon, rel };
      this.splashed = water;
      this.omega = 0;
      this.syncLanded(t);
      if (game && !this.isDebris) game.onTouchdown(this, water);
    }

    explode(game) {
      this.dead = true;
      if (game) game.onExplode(this);
    }

    checkSOI(t, game) {
      const b = this.body;
      if (b.parent && V.len(this.r) > b.soi) {
        this.r = V.add(this.r, FS.bodyPos(b, t));
        this.v = V.add(this.v, FS.bodyVel(b, t));
        this.body = b.parent;
        if (game) game.onSOIChange(this, b);
        return;
      }
      for (const c of b.children) {
        const cp = FS.bodyPos(c, t);
        if (Math.hypot(this.r.x - cp.x, this.r.y - cp.y) < c.soi) {
          this.r = V.sub(this.r, cp);
          this.v = V.sub(this.v, FS.bodyVel(c, t));
          this.body = c;
          if (game) game.onSOIChange(this, b);
          return;
        }
      }
    }

    // ---- On rails ----
    goOnRails(t) {
      this.rails = FS.orbitFromState(this.r, this.v, this.body.mu, t);
    }
    railsTo(t, game) {
      if (this.landed) { this.syncLanded(t); return; }
      const s = FS.orbitState(this.rails, t);
      this.r = s.r; this.v = s.v;
      this.angle += this.omega * 0; // orientation held
      const prevBody = this.body;
      this.checkSOI(t, game);
      if (this.body !== prevBody) this.goOnRails(t);
    }
    offRails() { this.rails = null; }

    situation() {
      const b = this.body;
      if (this.dead) return 'Destroyed';
      if (this.landed) return (this.splashed ? 'Splashed down on ' : 'Landed on ') + b.name;
      const alt = this.altitude;
      if (b.atmo && alt < b.atmo.height) return 'Flying over ' + b.name;
      const o = FS.orbitFromState(this.r, this.v, b.mu, 0);
      if (o.e >= 1 || o.ap > b.soi) return 'Escaping ' + b.name;
      const safe = b.R + (b.atmo ? b.atmo.height : b.terrain.amp * 1.5);
      if (o.pe > safe) return 'Orbiting ' + b.name;
      return 'Sub-orbital, ' + b.name;
    }
  }

  FS.Vessel = Vessel;
})();
