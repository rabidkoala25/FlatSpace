// vessel.js — a craft in flight: forces, torques, fuel, staging, landing, crashing.
// A vessel is a tree of parts (partgraph.js) moving as one rigid body. Its position r
// is its centre of mass; angle is the direction of its nose (+y of the craft frame).
// Methods that change the world take 'sim' (FS.game) and report what happened through
// sim.emit(): 'staged', 'touchdown', 'exploded' and 'soi'. They never draw anything.
(function () {
  const V = FS.vec;

  // Extra drag area from an open parachute (m²).
  function chuteArea(p) {
    if (p.chute === 'semi') return p.def.chute.semi * (p.deploy || 0);
    if (p.chute === 'full') return p.def.chute.semi + (p.def.chute.full - p.def.chute.semi) * Math.pow(p.deploy || 0, 2);
    return 0;
  }
  // Drag area when the air flows across the part instead of along it (m²). Fins add a lot.

  class Vessel {
    // source: part ids (a stack, top first), saved parts, or live parts (for debris).
    constructor(name, source, body, opts = {}) {
      this.name = name;
      this.parts = FS.toParts(source);
      // only the craft proper flies; floating parts from the editor are launched separately (sim.js)
      const root = FS.rootOf(this.parts);
      if (root && this.parts.some((p) => p !== root && !p.parent)) this.parts = FS.subtree(this.parts, root);
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
      this.thrustLocal = { x: 0, y: 0 };
      this.thrustTorque = 0;
      this.gimbalAuthority = 0;
      this.thrustAccel = { x: 0, y: 0 };
      this.heat = 0;           // 0..1 reentry glow
      this.q = 0;              // dynamic pressure (Pa)
      this.age = 0;
      this.stats = { maxAlt: 0, maxSpeed: 0, launched: false };
      this.relayout();
    }

    relayout() {
      this.layout = FS.massLayout(this.parts);
      this.mass = this.layout.mass;
      this.cda = this.parts.reduce((s, p) => s + p.cda + chuteArea(p), 0);
      this.torqueWheel = this.parts.reduce((s, p) => s + (p.def.torque || 0), 0);
      this.hasCommand = this.parts.some((p) => p.def.command);
    }

    get nose() { return V.fromAngle(this.angle); }
    // the craft's +x direction (to the right of the nose)
    get side() { const n = this.nose; return { x: n.y, y: -n.x }; }
    get altitude() { return V.len(this.r) - this.body.R; }
    // distance from the centre of mass to the lowest / highest point along the rocket axis
    get bottomDist() { return -this.layout.minY; }
    get topDist() { return this.layout.maxY; }

    // A craft-frame vector (relative to the centre of mass) in world coordinates.
    toWorld(v) {
      const n = this.nose;
      return { x: n.y * v.x + n.x * v.y, y: -n.x * v.x + n.y * v.y };
    }

    placeOnPad(t) {
      this.landed = { lon: this.body.pad.lon, rel: 0 };
      this.syncLanded(t);
    }

    syncLanded(t) {
      const b = this.body;
      const L = this.landed;
      const radAng = L.lon + FS.bodyRot(b, t);
      const ground = FS.surfaceHeight(b, L.lon);
      const rest = L.rel === 0 ? this.bottomDist : this.topDist;
      this.r = V.fromAngle(radAng, b.R + ground + rest + 0.02);
      this.v = FS.airVel(b, this.r);
      this.angle = radAng + L.rel;
      this.omega = b.omega;
    }

    // ---- Staging ----
    stage(sim) {
      if (this.stageIdx >= this.stages.length) return null;
      const ev = this.stages[this.stageIdx++];
      const dropped = [];
      if (ev.decouple) for (const dec of ev.decouplers) { const d = this.separate(dec); if (d) dropped.push(d); }
      if (ev.ignite) for (const e of ev.engines) if (this.parts.includes(e)) e.lit = true;
      if (ev.chutes) for (const p of this.parts) if (p.chute === 'stowed') p.chute = 'armed';
      this.stats.launched = true;
      // The simulation adds the dropped parts as debris when it hears this event.
      if (sim) sim.emit('staged', { vessel: this, event: ev, dropped });
      return ev;
    }

    // Use one part from its menu in flight: 'decouple' fires a decoupler, 'ignite' lights an
    // engine, 'shutdown' stops a liquid engine, 'deploy' arms a parachute. Reports what
    // happened with a 'part-action' event (the simulation adds any dropped parts as debris).
    act(part, action, sim) {
      if (!this.parts.includes(part)) return false;
      const d = part.def, dropped = [];
      if (action === 'decouple' && d.decoupler) { const deb = this.separate(part); if (!deb) return false; dropped.push(deb); }
      else if (action === 'ignite' && d.engine) part.lit = true;
      else if (action === 'shutdown' && d.engine && !d.engine.solid) part.lit = false;
      else if (action === 'deploy' && d.chute && part.chute === 'stowed') part.chute = 'armed';
      else return false;
      this.stats.launched = true;
      if (sim) sim.emit('part-action', { vessel: this, part, action, dropped });
      return true;
    }

    // Fire one decoupler: split the tree there. The side with the command part stays this
    // vessel; the other side is returned as a new debris vessel. Both keep their motion,
    // including the extra speed from the craft's spin, and get a small push apart.
    separate(dec) {
      if (!this.parts.includes(dec)) return null;
      const sub = new Set(FS.subtree(this.parts, dec));
      let keep = this.parts.filter((p) => !sub.has(p));
      let drop = [...sub];
      const hasCmd = (list) => list.some((p) => p.def.command);
      if (!hasCmd(keep) && hasCmd(drop)) [keep, drop] = [drop, keep];
      if (!keep.length || !drop.length) return null;

      const oldCom = this.layout.com, w = this.omega, r0 = this.r, v0 = this.v;
      const spin = (d) => ({ x: -w * d.y, y: w * d.x });
      const cut = (list) => { const set = new Set(list); for (const p of list) if (p.parent && !set.has(p.parent)) p.parent = null; };
      cut(keep); cut(drop);

      this.parts = keep;
      this.relayout();
      const dk = this.toWorld(V.sub(this.layout.com, oldCom));
      this.r = V.add(r0, dk);
      this.v = V.add(v0, spin(dk));

      const deb = new Vessel('Debris', drop, this.body, { debris: true });
      const dd = this.toWorld(V.sub(deb.layout.com, oldCom));
      deb.r = V.add(r0, dd);
      deb.v = V.add(v0, spin(dd));
      deb.angle = this.angle;
      deb.omega = w;
      deb.landed = null;

      let apart = V.sub(dd, dk);
      apart = V.len(apart) > 1e-6 ? V.norm(apart) : V.scale(this.nose, -1);
      deb.v = V.add(deb.v, V.scale(apart, 1.0));
      this.v = V.sub(this.v, V.scale(apart, 0.4));
      if (this.landed) this.landed = null;
      return deb;
    }

    deployChutes() {
      let any = false;
      for (const p of this.parts) if (p.chute === 'stowed') { p.chute = 'armed'; any = true; }
      return any;
    }

    // ---- Engines ----
    // Burns fuel for dt seconds and works out thrust: its total size, its direction and
    // turning effect in the craft frame, and how much the gimbals can steer.
    runEngines(dt, p) {
      let total = 0, torque = 0, gimbal = 0;
      let thrust = { x: 0, y: 0 };
      let anyLit = false, flame = false;
      this.nozzles = [];
      const push = (q, f, power, solid) => {
        const F = V.scale(q.axis, f);
        thrust = V.add(thrust, F);
        torque += V.cross(q.c, F);
        total += f;
        if (q.def.engine.gimbal) gimbal += f * Math.sin((q.def.engine.gimbal * (q.gimbal ?? 1) * Math.PI) / 180) * Math.abs(V.dot(q.c, q.axis));
        this.nozzles.push({ part: q, power, solid });
        flame = true;
      };
      for (const g of FS.flowGroups(this.parts)) {
        const liq = g.filter((q) => q.lit && q.def.engine && !q.def.engine.solid);
        const tanks = g.filter((q) => q.def.fuel);
        const fuel = tanks.reduce((s, q) => s + q.fuel, 0);
        if (liq.length) anyLit = true;
        if (liq.length && fuel > 0 && this.throttle > 0) {
          let mdot = 0;
          const each = liq.map((q) => { const t = FS.partThrust(q, p, this.throttle); mdot += t.mdot; return t.F; });
          let frac = 1;
          if (dt > 0) {
            const want = mdot * dt;
            frac = Math.min(1, fuel / want);
            const used = want * frac;
            for (const tk of tanks) tk.fuel = Math.max(0, tk.fuel - used * (tk.fuel / fuel));
          }
          liq.forEach((q, i) => push(q, each[i] * frac, this.throttle * frac, false));
        }
        for (const q of g) {
          if (q.lit && q.def.engine && q.def.engine.solid && q.solid > 0) {
            const t = FS.partThrust(q, p, 1);
            let frac = 1;
            if (dt > 0) { frac = Math.min(1, q.solid / (t.mdot * dt)); q.solid = Math.max(0, q.solid - t.mdot * dt * frac); }
            push(q, t.F * frac, frac, true);
          }
        }
      }
      this.thrustLocal = thrust;
      this.thrustTorque = torque;
      this.gimbalAuthority = gimbal;
      this.flameout = anyLit && !flame && this.throttle > 0;
      return total;
    }

    // Engines burning now (lit, with fuel), or if none, the engines the next stage lights.
    activeEngines() {
      const lit = [];
      for (const g of FS.flowGroups(this.parts)) {
        const fuel = g.reduce((s, q) => s + q.fuel, 0);
        for (const q of g) if (q.lit && q.def.engine && (q.def.engine.solid ? q.solid > 0 : fuel > 0)) lit.push(q);
      }
      if (lit.length) return lit;
      const next = this.stages.slice(this.stageIdx).find((e) => e.ignite);
      return next ? next.engines.filter((e) => this.parts.includes(e)) : [];
    }

    // Fuel left and capacity in the groups feeding the active engines.
    stageFuel() {
      const engines = new Set(this.activeEngines());
      let now = 0, max = 0;
      for (const g of FS.flowGroups(this.parts)) {
        if (!g.some((q) => engines.has(q))) continue;
        for (const q of g) {
          now += q.fuel + (engines.has(q) ? q.solid : 0);
          max += (q.cap || 0) + (engines.has(q) ? q.def.solid || 0 : 0);
        }
      }
      return { now, max };
    }

    sasTargetAngle(sim) {
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
          const nd = sim && sim.node;
          if (nd && nd.remaining && V.len(nd.remaining) > 0.01) return V.angle(nd.remaining);
          return this.sasTarget;
        }
      }
      return this.sasTarget;
    }

    // ---- Aerodynamics ----
    // The air's force on every part (FS.partAero: drag along the flow, and a sideways push
    // that fins feel most), each acting at the part's centre, so fins at the tail turn the
    // nose into the airflow. Returns the total force (world) and the turning effect about
    // the centre of mass.
    aero(vAir, q, angle) {
      const s = V.len(vAir);
      if (q <= 0 || s < 1e-6) return { F: { x: 0, y: 0 }, tau: 0 };
      const u = V.scale(vAir, 1 / s);
      const n = V.fromAngle(angle);
      const toW = (v) => ({ x: n.y * v.x + n.x * v.y, y: -n.x * v.x + n.y * v.y });
      const toL = (v) => ({ x: n.y * v.x - n.x * v.y, y: n.x * v.x + n.y * v.y });
      const uL = toL(u);
      let F = { x: 0, y: 0 }, tau = 0;
      for (const p of this.parts) {
        const Fp = toW(V.scale(FS.partAero(p, uL, chuteArea(p)), q));
        F = V.add(F, Fp);
        tau += V.cross(toW(p.c), Fp);
      }
      return { F, tau };
    }

    // ---- Physics step ----
    step(dt, t, sim) {
      if (this.dead) return;
      this.age += dt;
      const b = this.body;
      const p = FS.pressure(b, this.altitude);
      const rho = FS.density(b, this.altitude);

      // Parachute state machine
      const agl = this.altitude - FS.surfaceHeight(b, FS.lonAt(b, V.angle(this.r), t));
      for (const q of this.parts) {
        if (q.chute === 'armed' && p > 0.04 && V.len(V.sub(this.v, FS.airVel(b, this.r))) < 300) { q.chute = 'semi'; q.deploy = 0; }
        if (q.chute === 'semi' && agl < (q.chuteAlt ?? 1000)) { q.chute = 'full'; q.deploy = 0; }
        if ((q.chute === 'semi' || q.chute === 'full') && q.deploy < 1) q.deploy = Math.min(1, q.deploy + dt * 0.4);
      }

      // Engines
      const Fmag = this.runEngines(dt, p);
      this.thrustNow = Fmag;
      this.relayout();
      const m = this.mass;
      const thrustVec = this.toWorld(this.thrustLocal);

      if (this.landed) {
        // Resting on the ground: lift off only if thrust beats weight.
        const up = V.norm(this.r);
        const g = b.mu / V.dot(this.r, this.r);
        if (V.dot(thrustVec, up) > m * g * 1.0001) {
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
      const drag = this.aero(vAir, q, this.angle);
      this.thrustAccel = V.scale(thrustVec, 1 / m);
      const acc = V.add(gAcc, V.scale(V.add(thrustVec, drag.F), 1 / m));
      this.v = V.add(this.v, V.scale(acc, dt));
      this.r = V.add(this.r, V.scale(this.v, dt));
      this.gForce = V.len(V.sub(acc, gAcc)) / FS.G0;
      this.heat = FS.clamp((rho * sAir * sAir * sAir) / 6e7 - 0.1, 0, 1);

      // Torques (sub-stepped for stability with strong aero torques)
      const I = this.layout.I;
      const maxT = this.hasCommand ? this.torqueWheel + this.gimbalAuthority : 0;
      const len = this.layout.height;
      const sub = 4;
      const h = dt / sub;
      for (let k = 0; k < sub; k++) {
        let tau = this.thrustTorque; // engines off the centre line turn the craft
        if (q > 0) {
          tau += this.aero(vAir, q, this.angle).tau;
          tau -= 0.6 * q * this.cda * len * len * this.omega / Math.max(sAir, 5); // damping
        }
        if (!this.isDebris && maxT > 0) {
          if (this.rot !== 0) {
            tau += this.rot * maxT;
            this.sasTarget = this.angle;
          } else if (this.sas) {
            let target = this.sasTargetAngle(sim);
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

      this.checkGround(t, sim);
      this.checkSOI(t, sim);
    }

    // Test every corner of every part against the ground.
    checkGround(t, sim) {
      const b = this.body;
      const reach = Math.max(this.layout.height, this.layout.width);
      if (this.altitude > b.terrain.amp * 2.5 + reach + 50) return; // far above any ground
      let hit = null;
      for (const p of this.parts) {
        for (const hp of p.hullC) {
          const pt = V.add(this.r, this.toWorld(hp));
          const lon = FS.lonAt(b, V.angle(pt), t);
          const clear = V.len(pt) - b.R - FS.surfaceHeight(b, lon);
          if (clear < 0 && (!hit || clear < hit.clear)) hit = { clear, part: p, lon, bottom: hp.y < 0 };
        }
      }
      if (!hit) return;
      const speed = V.len(V.sub(this.v, FS.airVel(b, this.r)));
      const up = V.norm(this.r);
      const tilt = Math.acos(FS.clamp(V.dot(this.nose, up), -1, 1));
      const water = b.ocean && FS.terrainHeight(b, hit.lon) < 0;
      const tol = hit.part.def.crash;
      if (this.isDebris && speed > 12) { this.explode(sim); return; }
      if (water && speed < 20 && (tilt < 0.6 || tilt > Math.PI - 0.6 || speed < 8)) { this.setLanded(t, true, sim); return; }
      if (!water && hit.bottom && tilt < 0.5 && speed < tol) { this.setLanded(t, false, sim); return; }
      if (!water && !hit.bottom && tilt > Math.PI - 0.5 && speed < tol) { this.setLanded(t, false, sim); return; }
      if (speed < 3) { this.setLanded(t, water, sim); return; }
      this.explode(sim);
    }

    setLanded(t, water, sim) {
      const b = this.body;
      const radAng = V.angle(this.r);
      const lon = FS.lonAt(b, radAng, t);
      // settle upright or upside-down, whichever is closer
      let rel = FS.wrapAngle(this.angle - radAng);
      rel = Math.abs(rel) > Math.PI / 2 ? Math.PI : 0;
      this.landed = { lon, rel };
      this.splashed = water;
      this.omega = 0;
      this.syncLanded(t);
      if (sim && !this.isDebris) sim.emit('touchdown', { vessel: this, water });
    }

    explode(sim) {
      this.dead = true;
      if (sim) sim.emit('exploded', { vessel: this });
    }

    checkSOI(t, sim) {
      const b = this.body;
      if (b.parent && V.len(this.r) > b.soi) {
        this.r = V.add(this.r, FS.bodyPos(b, t));
        this.v = V.add(this.v, FS.bodyVel(b, t));
        this.body = b.parent;
        if (sim) sim.emit('soi', { vessel: this, from: b });
        return;
      }
      for (const c of b.children) {
        const cp = FS.bodyPos(c, t);
        if (Math.hypot(this.r.x - cp.x, this.r.y - cp.y) < c.soi) {
          this.r = V.sub(this.r, cp);
          this.v = V.sub(this.v, FS.bodyVel(c, t));
          this.body = c;
          if (sim) sim.emit('soi', { vessel: this, from: b });
          return;
        }
      }
    }

    // ---- On rails ----
    goOnRails(t) {
      this.rails = FS.orbitFromState(this.r, this.v, this.body.mu, t);
    }
    railsTo(t, sim) {
      if (this.landed) { this.syncLanded(t); return; }
      const s = FS.orbitState(this.rails, t);
      this.r = s.r; this.v = s.v;
      const prevBody = this.body;
      this.checkSOI(t, sim);
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
