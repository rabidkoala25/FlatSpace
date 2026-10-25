// vessel.js — a craft in flight: forces, torques, fuel, staging, landing, crashing.
// A vessel is a tree of parts (partgraph.js) moving as one rigid body. Its position r
// is its centre of mass; angle is the direction of its nose (+y of the craft frame).
// Methods that change the world take 'sim' (FS.game) and report what happened through
// sim.emit(): 'staged', 'touchdown', 'exploded' and 'soi'. They never draw anything.
(function () {
  const Vector = FS.vec;

  // Extra drag area from an open parachute (m²).
  function chuteArea(part) {
    if (part.chute === 'semi') {
      return part.def.chute.semi * (part.deploy || 0);
    }
    if (part.chute === 'full') {
      return (
        part.def.chute.semi + (part.def.chute.full - part.def.chute.semi) * Math.pow(part.deploy || 0, 2)
      );
    }
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
      if (root && this.parts.some((part) => part !== root && !part.parent)) {
        this.parts = FS.subtree(this.parts, root);
      }
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
      this.rot = 0; // player rotation input, -1..1
      this.landed = null; // {lon, rel} when resting on the ground
      this.splashed = false;
      this.dead = false;
      this.thrustNow = 0;
      this.thrustLocal = { x: 0, y: 0 };
      this.thrustTorque = 0;
      this.gimbalAuthority = 0;
      this.thrustAccel = { x: 0, y: 0 };
      this.heat = 0; // 0..1 reentry glow
      this.q = 0; // dynamic pressure (Pa)
      this.age = 0;
      this.stats = { maxAlt: 0, maxSpeed: 0, launched: false };
      this.relayout();
    }

    relayout() {
      this.layout = FS.massLayout(this.parts);
      this.mass = this.layout.mass;
      this.cda = this.parts.reduce((sum, part) => sum + part.cda + chuteArea(part), 0);
      this.torqueWheel = this.parts.reduce((sum, part) => sum + (part.def.torque || 0), 0);
      this.hasCommand = this.parts.some((part) => part.def.command);
    }

    get nose() {
      return Vector.fromAngle(this.angle);
    }
    // the craft's +x direction (to the right of the nose)
    get side() {
      const nose = this.nose;
      return { x: nose.y, y: -nose.x };
    }
    get altitude() {
      return Vector.len(this.r) - this.body.R;
    }
    // distance from the centre of mass to the lowest / highest point along the rocket axis
    get bottomDist() {
      return -this.layout.minY;
    }
    get topDist() {
      return this.layout.maxY;
    }

    // Height of the centre of mass above the ground when resting at angle rel from upright.
    restDist(tilt) {
      if (tilt === 0) {
        return this.bottomDist;
      }
      if (tilt === Math.PI) {
        return this.topDist;
      }
      const worldUp = { x: Math.sin(tilt), y: Math.cos(tilt) }; // world "up" in the craft frame
      let depth = 0;
      for (const part of this.parts) {
        for (const hullPoint of part.hullC) {
          depth = Math.max(depth, -Vector.dot(hullPoint, worldUp));
        }
      }
      return depth;
    }

    // Resting on the ground, does the engines' turning effect beat what the weight can hold?
    // The craft tips over the edge of its base on the side it is turning towards.
    tipsOver(thrustVec, mass, gravity) {
      const torque = this.thrustTorque;
      if (Math.abs(torque) < 1) {
        return false;
      }
      const tilt = this.landed.rel;
      const worldUp = { x: Math.sin(tilt), y: Math.cos(tilt) };
      const right = { x: Math.cos(tilt), y: -Math.sin(tilt) };
      let lowest = Infinity;
      for (const part of this.parts) {
        for (const hullPoint of part.hullC) {
          lowest = Math.min(lowest, Vector.dot(hullPoint, worldUp));
        }
      }
      const side = torque < 0 ? 1 : -1; // turning clockwise lowers the right-hand side
      let edge = 0;
      for (const part of this.parts) {
        for (const hullPoint of part.hullC) {
          if (Vector.dot(hullPoint, worldUp) < lowest + 0.25) {
            edge = Math.max(edge, side * Vector.dot(hullPoint, right));
          }
        }
      }
      const normalForce = Math.max(0, mass * gravity - Vector.dot(thrustVec, Vector.norm(this.r)));
      return Math.abs(torque) > normalForce * edge;
    }

    // A craft-frame vector (relative to the centre of mass) in world coordinates.
    toWorld(local) {
      const nose = this.nose;
      return { x: nose.y * local.x + nose.x * local.y, y: -nose.x * local.x + nose.y * local.y };
    }

    placeOnPad(time) {
      this.landed = { lon: this.body.pad.lon, rel: 0 };
      this.syncLanded(time);
    }

    syncLanded(time) {
      const body = this.body;
      const landing = this.landed;
      const radAng = landing.lon + FS.bodyRot(body, time);
      const ground = FS.surfaceHeight(body, landing.lon);
      const rest = this.restDist(landing.rel);
      this.r = Vector.fromAngle(radAng, body.R + ground + rest + 0.02);
      this.v = FS.airVel(body, this.r);
      this.angle = radAng + landing.rel;
      this.omega = body.omega;
    }

    // ---- Staging ----
    stage(game) {
      if (this.stageIdx >= this.stages.length) {
        return null;
      }
      const stage = this.stages[this.stageIdx++];
      const dropped = [];
      if (stage.decouple) {
        for (const decoupler of stage.decouplers) {
          const droppedVessel = this.separate(decoupler);
          if (droppedVessel) {
            dropped.push(droppedVessel);
          }
        }
      }
      if (stage.ignite) {
        for (const engine of stage.engines) {
          if (this.parts.includes(engine)) {
            engine.lit = true;
          }
        }
      }
      if (stage.chutes) {
        for (const part of this.parts) {
          if (part.chute === 'stowed') {
            part.chute = 'armed';
          }
        }
      }
      this.stats.launched = true;
      // The simulation adds the dropped parts as debris when it hears this event.
      if (game) {
        game.emit('staged', { vessel: this, event: stage, dropped });
      }
      return stage;
    }

    // Use one part from its menu in flight: 'decouple' fires a decoupler, 'ignite' lights an
    // engine, 'shutdown' stops a liquid engine, 'deploy' arms a parachute. Reports what
    // happened with a 'part-action' event (the simulation adds any dropped parts as debris).
    act(part, action, game) {
      if (!this.parts.includes(part)) {
        return false;
      }
      const partType = part.def;
      const dropped = [];
      if (action === 'decouple' && partType.decoupler) {
        const debrisVessel = this.separate(part);
        if (!debrisVessel) {
          return false;
        }
        dropped.push(debrisVessel);
      } else if (action === 'ignite' && partType.engine) {
        part.lit = true;
      } else if (action === 'shutdown' && partType.engine && !partType.engine.solid) {
        part.lit = false;
      } else if (action === 'deploy' && partType.chute && part.chute === 'stowed') {
        part.chute = 'armed';
      } else {
        return false;
      }
      this.stats.launched = true;
      if (game) {
        game.emit('part-action', { vessel: this, part, action, dropped });
      }
      return true;
    }

    // Fire one decoupler: split the tree there. The side with the command part stays this
    // vessel; the other side is returned as a new debris vessel. Both keep their motion,
    // including the extra speed from the craft's spin, and get a small push apart.
    separate(decoupler) {
      if (!this.parts.includes(decoupler)) {
        return null;
      }
      const droppedSet = new Set(FS.subtree(this.parts, decoupler));
      let keep = this.parts.filter((part) => !droppedSet.has(part));
      let drop = [...droppedSet];
      const hasCmd = (list) => list.some((part) => part.def.command);
      if (!hasCmd(keep) && hasCmd(drop)) {
        [keep, drop] = [drop, keep];
      }
      if (!keep.length || !drop.length) {
        return null;
      }

      const oldCom = this.layout.com;
      const spinRate = this.omega;
      const oldPosition = this.r;
      const oldVelocity = this.v;
      const spin = (offset) => ({ x: -spinRate * offset.y, y: spinRate * offset.x });
      const detach = (list) => {
        const set = new Set(list);
        for (const part of list) {
          if (part.parent && !set.has(part.parent)) {
            part.parent = null;
          }
        }
      };
      detach(keep);
      detach(drop);

      this.parts = keep;
      this.relayout();
      const keptShift = this.toWorld(Vector.sub(this.layout.com, oldCom));
      this.r = Vector.add(oldPosition, keptShift);
      this.v = Vector.add(oldVelocity, spin(keptShift));

      const debrisVessel = new Vessel('Debris', drop, this.body, { debris: true });
      const droppedShift = this.toWorld(Vector.sub(debrisVessel.layout.com, oldCom));
      debrisVessel.r = Vector.add(oldPosition, droppedShift);
      debrisVessel.v = Vector.add(oldVelocity, spin(droppedShift));
      debrisVessel.angle = this.angle;
      debrisVessel.omega = spinRate;
      debrisVessel.landed = null;

      let apart = Vector.sub(droppedShift, keptShift);
      apart = Vector.len(apart) > 1e-6 ? Vector.norm(apart) : Vector.scale(this.nose, -1);
      debrisVessel.v = Vector.add(debrisVessel.v, Vector.scale(apart, 1.0));
      this.v = Vector.sub(this.v, Vector.scale(apart, 0.4));
      if (this.landed) {
        this.landed = null;
      }
      return debrisVessel;
    }

    deployChutes() {
      let anyArmed = false;
      for (const part of this.parts) {
        if (part.chute === 'stowed') {
          part.chute = 'armed';
          anyArmed = true;
        }
      }
      return anyArmed;
    }

    // ---- Engines ----
    // Burns fuel for dt seconds and works out thrust: its total size, its direction and
    // turning effect in the craft frame, and how much the gimbals can steer.
    runEngines(timeStep, pressure) {
      let total = 0;
      let torque = 0;
      let gimbal = 0;
      let thrust = { x: 0, y: 0 };
      let anyLit = false;
      let flame = false;
      this.nozzles = [];
      const push = (engine, force, power, solid) => {
        const forceVector = Vector.scale(engine.axis, force);
        thrust = Vector.add(thrust, forceVector);
        torque += Vector.cross(engine.c, forceVector);
        total += force;
        if (engine.def.engine.gimbal) {
          gimbal +=
            force *
            Math.sin((engine.def.engine.gimbal * (engine.gimbal ?? 1) * Math.PI) / 180) *
            Math.abs(Vector.dot(engine.c, engine.axis));
        }
        this.nozzles.push({ part: engine, power, solid });
        flame = true;
      };
      for (const fuelGroup of FS.flowGroups(this.parts)) {
        const liquidEngines = fuelGroup.filter(
          (groupPart) => groupPart.lit && groupPart.def.engine && !groupPart.def.engine.solid,
        );
        const tanks = fuelGroup.filter((groupPart) => groupPart.def.fuel);
        const fuel = tanks.reduce((sum, tank) => sum + tank.fuel, 0);
        if (liquidEngines.length) {
          anyLit = true;
        }
        if (liquidEngines.length && fuel > 0 && this.throttle > 0) {
          let mdot = 0;
          const each = liquidEngines.map((engine) => {
            const thrust = FS.partThrust(engine, pressure, this.throttle);
            mdot += thrust.mdot;
            return thrust.F;
          });
          let frac = 1;
          if (timeStep > 0) {
            const want = mdot * timeStep;
            frac = Math.min(1, fuel / want);
            const used = want * frac;
            for (const tank of tanks) {
              tank.fuel = Math.max(0, tank.fuel - used * (tank.fuel / fuel));
            }
          }
          liquidEngines.forEach((engine, index) =>
            push(engine, each[index] * frac, this.throttle * frac, false),
          );
        }
        for (const groupPart of fuelGroup) {
          if (groupPart.lit && groupPart.def.engine && groupPart.def.engine.solid && groupPart.solid > 0) {
            const thrust = FS.partThrust(groupPart, pressure, 1);
            let frac = 1;
            if (timeStep > 0) {
              frac = Math.min(1, groupPart.solid / (thrust.mdot * timeStep));
              groupPart.solid = Math.max(0, groupPart.solid - thrust.mdot * timeStep * frac);
            }
            push(groupPart, thrust.F * frac, frac, true);
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
      const litEngines = [];
      for (const fuelGroup of FS.flowGroups(this.parts)) {
        const fuel = fuelGroup.reduce((sum, groupPart) => sum + groupPart.fuel, 0);
        for (const groupPart of fuelGroup) {
          if (
            groupPart.lit &&
            groupPart.def.engine &&
            (groupPart.def.engine.solid ? groupPart.solid > 0 : fuel > 0)
          ) {
            litEngines.push(groupPart);
          }
        }
      }
      if (litEngines.length) {
        return litEngines;
      }
      const next = this.stages.slice(this.stageIdx).find((stage) => stage.ignite);
      return next ? next.engines.filter((engine) => this.parts.includes(engine)) : [];
    }

    // Fuel left and capacity in the groups feeding the active engines.
    stageFuel() {
      const engines = new Set(this.activeEngines());
      let now = 0;
      let max = 0;
      for (const fuelGroup of FS.flowGroups(this.parts)) {
        if (!fuelGroup.some((groupPart) => engines.has(groupPart))) {
          continue;
        }
        for (const groupPart of fuelGroup) {
          now += groupPart.fuel + (engines.has(groupPart) ? groupPart.solid : 0);
          max += (groupPart.cap || 0) + (engines.has(groupPart) ? groupPart.def.solid || 0 : 0);
        }
      }
      return { now, max };
    }

    sasTargetAngle(game) {
      const mode = this.sasMode;
      if (mode === 'stability') {
        return this.sasTarget;
      }
      const position = this.r;
      const surf = this.altitude < (this.body.atmo ? this.body.atmo.height * 0.5 : 10000);
      const velocity = surf ? Vector.sub(this.v, FS.airVel(this.body, position)) : this.v;
      if (Vector.len(velocity) < 0.5 && (mode === 'prograde' || mode === 'retrograde')) {
        return this.sasTarget;
      }
      const velocityAngle = Vector.angle(velocity);
      const radialAngle = Vector.angle(position);
      switch (mode) {
        case 'prograde':
          return velocityAngle;
        case 'retrograde':
          return velocityAngle + Math.PI;
        case 'radialout':
          return radialAngle;
        case 'radialin':
          return radialAngle + Math.PI;
        case 'maneuver': {
          const node = game && game.node;
          if (node && node.remaining && Vector.len(node.remaining) > 0.01) {
            return Vector.angle(node.remaining);
          }
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
    aero(vAir, dynamicPressure, angle) {
      const airSpeed = Vector.len(vAir);
      if (dynamicPressure <= 0 || airSpeed < 1e-6) {
        return { F: { x: 0, y: 0 }, tau: 0 };
      }
      const airDirection = Vector.scale(vAir, 1 / airSpeed);
      const nose = Vector.fromAngle(angle);
      const toWorldFrame = (vector) => ({
        x: nose.y * vector.x + nose.x * vector.y,
        y: -nose.x * vector.x + nose.y * vector.y,
      });
      const toLocalFrame = (vector) => ({
        x: nose.y * vector.x - nose.x * vector.y,
        y: nose.x * vector.x + nose.y * vector.y,
      });
      const localAirDirection = toLocalFrame(airDirection);
      let force = { x: 0, y: 0 };
      let torque = 0;
      for (const part of this.parts) {
        const partForce = toWorldFrame(
          Vector.scale(FS.partAero(part, localAirDirection, chuteArea(part)), dynamicPressure),
        );
        force = Vector.add(force, partForce);
        torque += Vector.cross(toWorldFrame(part.c), partForce);
      }
      return { F: force, tau: torque };
    }

    // ---- Physics step ----
    step(timeStep, time, game) {
      if (this.dead) {
        return;
      }
      this.age += timeStep;
      const body = this.body;
      const pressure = FS.pressure(body, this.altitude);
      const airDensity = FS.density(body, this.altitude);

      // Parachute state machine
      const heightAboveGround =
        this.altitude - FS.surfaceHeight(body, FS.lonAt(body, Vector.angle(this.r), time));
      for (const part of this.parts) {
        if (
          part.chute === 'armed' &&
          pressure > 0.04 &&
          Vector.len(Vector.sub(this.v, FS.airVel(body, this.r))) < 300
        ) {
          part.chute = 'semi';
          part.deploy = 0;
        }
        if (part.chute === 'semi' && heightAboveGround < (part.chuteAlt ?? 1000)) {
          part.chute = 'full';
          part.deploy = 0;
        }
        if ((part.chute === 'semi' || part.chute === 'full') && part.deploy < 1) {
          part.deploy = Math.min(1, part.deploy + timeStep * 0.4);
        }
      }

      // Engines
      const Fmag = this.runEngines(timeStep, pressure);
      this.thrustNow = Fmag;
      this.relayout();
      const mass = this.mass;
      const thrustVec = this.toWorld(this.thrustLocal);

      if (this.landed) {
        // Resting on the ground: lift off only if thrust beats weight.
        const worldUp = Vector.norm(this.r);
        const gravity = body.mu / Vector.dot(this.r, this.r);
        if (Vector.dot(thrustVec, worldUp) > mass * gravity * 1.0001) {
          this.landed = null;
          this.splashed = false;
          this.r = Vector.add(this.r, Vector.scale(worldUp, 0.05));
        } else if (this.tipsOver(thrustVec, mass, gravity)) {
          // engines turning the craft harder than its weight holds it: it tips and pivots on the ground
          this.landed = null;
          this.splashed = false;
          this.rolling = true;
          this.r = Vector.add(this.r, Vector.scale(worldUp, 0.01));
        } else {
          this.syncLanded(time);
          this.thrustAccel = { x: 0, y: 0 };
          return;
        }
      }

      // Forces
      const rlen = Vector.len(this.r);
      const gAcc = Vector.scale(this.r, -body.mu / (rlen * rlen * rlen));
      const vAir = Vector.sub(this.v, FS.airVel(body, this.r));
      const sAir = Vector.len(vAir);
      const dynamicPressure = 0.5 * airDensity * sAir * sAir;
      this.q = dynamicPressure;
      const drag = this.aero(vAir, dynamicPressure, this.angle);
      this.thrustAccel = Vector.scale(thrustVec, 1 / mass);
      const acceleration = Vector.add(gAcc, Vector.scale(Vector.add(thrustVec, drag.F), 1 / mass));
      this.v = Vector.add(this.v, Vector.scale(acceleration, timeStep));
      this.r = Vector.add(this.r, Vector.scale(this.v, timeStep));
      this.gForce = Vector.len(Vector.sub(acceleration, gAcc)) / FS.G0;
      this.heat = FS.clamp((airDensity * sAir * sAir * sAir) / 6e7 - 0.1, 0, 1);

      // Torques (sub-stepped for stability with strong aero torques)
      const inertia = this.layout.I;
      const maxT = this.hasCommand ? this.torqueWheel + this.gimbalAuthority : 0;
      const craftLength = this.layout.height;
      const substeps = 4;
      const substep = timeStep / substeps;
      for (let substepIndex = 0; substepIndex < substeps; substepIndex++) {
        let torque = this.thrustTorque; // engines off the centre line turn the craft
        if (dynamicPressure > 0) {
          torque += this.aero(vAir, dynamicPressure, this.angle).tau;
          torque -=
            (0.6 * dynamicPressure * this.cda * craftLength * craftLength * this.omega) / Math.max(sAir, 5); // damping
        }
        if (!this.isDebris && maxT > 0) {
          if (this.rot !== 0) {
            torque += this.rot * maxT;
            this.sasTarget = this.angle;
          } else if (this.sas) {
            let target = this.sasTargetAngle(game);
            if (target == null) {
              this.sasTarget = this.angle;
              target = this.angle;
            }
            const angleError = FS.wrapAngle(target - this.angle);
            const alphaMax = maxT / inertia;
            const wMax = Math.min(1.2, Math.sqrt(2 * alphaMax * Math.abs(angleError)) * 0.8);
            const targetSpin = FS.clamp(angleError * 2.5, -wMax, wMax);
            torque += FS.clamp(inertia * (targetSpin - this.omega) * 10, -maxT, maxT);
          }
        }
        this.omega += (torque / inertia) * substep;
        this.omega = FS.clamp(this.omega, -12, 12);
        this.angle += this.omega * substep;
      }
      this.angle = FS.wrapAngle(this.angle);

      // Stats
      const altitude = this.altitude;
      if (body === FS.root) {
        this.stats.maxAlt = Math.max(this.stats.maxAlt, altitude);
      }
      this.stats.maxSpeed = Math.max(this.stats.maxSpeed, Vector.len(this.v));

      this.checkGround(time, game);
      this.checkSOI(time, game);
    }

    // Test every corner of every part against the ground.
    checkGround(time, game) {
      const body = this.body;
      const reach = Math.max(this.layout.height, this.layout.width);
      const farAbove = this.altitude > body.terrain.amp * 2.5 + reach + 50; // far above any ground
      let hit = null;
      const touching = [];
      if (!farAbove) {
        for (const part of this.parts) {
          for (const hullPoint of part.hullC) {
            const point = Vector.add(this.r, this.toWorld(hullPoint));
            const longitude = FS.lonAt(body, Vector.angle(point), time);
            const clear = Vector.len(point) - body.R - FS.surfaceHeight(body, longitude);
            if (clear < 0) {
              touching.push({ hp: hullPoint, pt: point, part: part, clear });
              if (!hit || clear < hit.clear) {
                hit = { clear, part: part, lon: longitude, bottom: hullPoint.y < 0 };
              }
            }
          }
        }
      }
      if (this.rolling) {
        if (hit) {
          this.lastContact = time;
        } else if (time - (this.lastContact ?? time) > 1) {
          this.rolling = false;
        } // thrown clear: flying again
      }
      if (!hit) {
        return;
      }
      if (this.rolling || Math.abs(this.omega - body.omega) > 0.5) {
        this.groundContact(time, game, hit, touching);
        return;
      }
      const speed = Vector.len(Vector.sub(this.v, FS.airVel(body, this.r)));
      const worldUp = Vector.norm(this.r);
      const tilt = Math.acos(FS.clamp(Vector.dot(this.nose, worldUp), -1, 1));
      const water = body.ocean && FS.terrainHeight(body, hit.lon) < 0;
      const crashTolerance = hit.part.def.crash;
      if (this.isDebris && speed > 12) {
        this.explode(game);
        return;
      }
      if (water && speed < 20 && (tilt < 0.6 || tilt > Math.PI - 0.6 || speed < 8)) {
        this.setLanded(time, true, game);
        return;
      }
      if (!water && hit.bottom && tilt < 0.5 && speed < crashTolerance) {
        this.setLanded(time, false, game);
        return;
      }
      if (!water && !hit.bottom && tilt > Math.PI - 0.5 && speed < crashTolerance) {
        this.setLanded(time, false, game);
        return;
      }
      if (speed < 3) {
        this.setLanded(time, water, game);
        return;
      }
      this.explode(game);
    }

    // Interim ground contact for a craft turning on the ground (step C1 replaces it with a
    // rigid-body engine): every touching corner pushes back and grips with friction, so the
    // craft pivots, rolls and bounces. A corner hitting the ground too fast breaks the craft.
    groundContact(time, game, hit, touching) {
      const body = this.body;
      const mass = this.mass;
      const inertia = this.layout.I;
      const worldUp = Vector.norm(this.r);
      const tangent = { x: -worldUp.y, y: worldUp.x };
      const pointVel = (offset, point) =>
        Vector.sub(
          { x: this.v.x - this.omega * offset.y, y: this.v.y + this.omega * offset.x },
          FS.airVel(body, point),
        );
      this.rolling = true;
      this.lastContact = time;
      for (const contact of touching) {
        const offset = this.toWorld(contact.hp);
        if (Vector.len(pointVel(offset, contact.pt)) > contact.part.def.crash) {
          this.explode(game);
          return;
        }
      }
      this.r = Vector.add(this.r, Vector.scale(worldUp, -hit.clear));
      for (let pass = 0; pass < 2; pass++) {
        for (const contact of touching) {
          const offset = this.toWorld(contact.hp);
          const pointVelocity = pointVel(offset, contact.pt);
          const normalSpeed = Vector.dot(pointVelocity, worldUp);
          if (normalSpeed >= 0) {
            continue;
          }
          const normalLever = Vector.cross(offset, worldUp);
          const impulse =
            (-(1 + 0.1) * normalSpeed) / (1 / mass + (normalLever * normalLever) / inertia) / touching.length;
          this.v = Vector.add(this.v, Vector.scale(worldUp, impulse / mass));
          this.omega += (normalLever * impulse) / inertia;
          const tangentLever = Vector.cross(offset, tangent);
          const tangentSpeed = Vector.dot(pointVel(offset, contact.pt), tangent);
          const frictionImpulse = FS.clamp(
            -tangentSpeed / (1 / mass + (tangentLever * tangentLever) / inertia),
            -0.8 * impulse,
            0.8 * impulse,
          );
          this.v = Vector.add(this.v, Vector.scale(tangent, frictionImpulse / mass));
          this.omega += (tangentLever * frictionImpulse) / inertia;
        }
      }
      // settled: at rest for half a second, and the engines can't turn it any more
      // (a little contact jitter is allowed: only a real movement restarts the clock)
      const speed = Vector.len(Vector.sub(this.v, FS.airVel(body, this.r)));
      const spin = Math.abs(this.omega - body.omega);
      if (speed > 1 || spin > 0.15) {
        this.stillSince = null;
      } else if (speed < 0.5 && spin < 0.1) {
        this.stillSince = this.stillSince ?? time;
      }
      const still = this.stillSince != null;
      if (still && time - this.stillSince > 0.5 && Math.abs(this.thrustTorque) < 1) {
        const radAng = Vector.angle(this.r);
        this.landed = { lon: FS.lonAt(body, radAng, time), rel: FS.wrapAngle(this.angle - radAng) };
        this.rolling = false;
        this.stillSince = null;
        this.splashed = !!(body.ocean && FS.terrainHeight(body, hit.lon) < 0);
        this.omega = 0;
        this.syncLanded(time);
        if (game && !this.isDebris) {
          game.emit('touchdown', { vessel: this, water: this.splashed });
        }
      }
    }

    setLanded(time, water, game) {
      const body = this.body;
      const radAng = Vector.angle(this.r);
      const longitude = FS.lonAt(body, radAng, time);
      // settle upright or upside-down, whichever is closer
      let tilt = FS.wrapAngle(this.angle - radAng);
      tilt = Math.abs(tilt) > Math.PI / 2 ? Math.PI : 0;
      this.landed = { lon: longitude, rel: tilt };
      this.splashed = water;
      this.omega = 0;
      this.syncLanded(time);
      if (game && !this.isDebris) {
        game.emit('touchdown', { vessel: this, water });
      }
    }

    explode(game) {
      this.dead = true;
      if (game) {
        game.emit('exploded', { vessel: this });
      }
    }

    checkSOI(time, game) {
      const body = this.body;
      if (body.parent && Vector.len(this.r) > body.soi) {
        this.r = Vector.add(this.r, FS.bodyPos(body, time));
        this.v = Vector.add(this.v, FS.bodyVel(body, time));
        this.body = body.parent;
        if (game) {
          game.emit('soi', { vessel: this, from: body });
        }
        return;
      }
      for (const moon of body.children) {
        const moonPosition = FS.bodyPos(moon, time);
        if (Math.hypot(this.r.x - moonPosition.x, this.r.y - moonPosition.y) < moon.soi) {
          this.r = Vector.sub(this.r, moonPosition);
          this.v = Vector.sub(this.v, FS.bodyVel(moon, time));
          this.body = moon;
          if (game) {
            game.emit('soi', { vessel: this, from: body });
          }
          return;
        }
      }
    }

    // ---- On rails ----
    goOnRails(time) {
      this.rails = FS.orbitFromState(this.r, this.v, this.body.mu, time);
    }
    railsTo(time, game) {
      if (this.landed) {
        this.syncLanded(time);
        return;
      }
      const state = FS.orbitState(this.rails, time);
      this.r = state.r;
      this.v = state.v;
      const prevBody = this.body;
      this.checkSOI(time, game);
      if (this.body !== prevBody) {
        this.goOnRails(time);
      }
    }
    offRails() {
      this.rails = null;
    }

    situation() {
      const body = this.body;
      if (this.dead) {
        return 'Destroyed';
      }
      if (this.landed) {
        return (this.splashed ? 'Splashed down on ' : 'Landed on ') + body.name;
      }
      const altitude = this.altitude;
      if (body.atmo && altitude < body.atmo.height) {
        return 'Flying over ' + body.name;
      }
      const orbit = FS.orbitFromState(this.r, this.v, body.mu, 0);
      if (orbit.e >= 1 || orbit.ap > body.soi) {
        return 'Escaping ' + body.name;
      }
      const safe = body.R + (body.atmo ? body.atmo.height : body.terrain.amp * 1.5);
      if (orbit.pe > safe) {
        return 'Orbiting ' + body.name;
      }
      return 'Sub-orbital, ' + body.name;
    }
  }

  FS.Vessel = Vessel;
})();
