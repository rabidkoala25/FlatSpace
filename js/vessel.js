// vessel.js — a craft in flight: forces, torques, fuel, staging, landing, crashing.
// A vessel is a tree of parts (partgraph.js) moving as one rigid body. Its position
// is its centre of mass; angle is the direction of its nose (+y of the craft frame).
// Methods that change the world take 'sim' (Flatspace.game) and report what happened through
// sim.emit(): 'staged', 'touchdown', 'exploded' and 'soi'. They never draw anything.
(function () {
  const Vector = Flatspace.Vector;

  // Extra drag area from an open parachute (m²).
  function chuteArea(part) {
    if (part.chute === 'halfOpen') {
      return part.type.chute.halfOpen * (part.deploy || 0);
    }
    if (part.chute === 'full') {
      return (
        part.type.chute.halfOpen +
        (part.type.chute.full - part.type.chute.halfOpen) * Math.pow(part.deploy || 0, 2)
      );
    }
    return 0;
  }
  // Drag area when the air flows across the part instead of along it (m²). Fins add a lot.

  class Vessel {
    // source: part ids (a stack, top first), saved parts, or live parts (for debris).
    constructor(name, source, body, options = {}) {
      this.name = name;
      this.parts = Flatspace.toParts(source);
      // only the craft proper flies; floating parts from the editor are launched separately (sim.js)
      const root = Flatspace.rootOf(this.parts);
      if (root && this.parts.some((part) => part !== root && !part.parent)) {
        this.parts = Flatspace.subtree(this.parts, root);
      }
      this.body = body;
      this.position = { x: body.radius, y: 0 };
      this.velocity = { x: 0, y: 0 };
      this.angle = 0;
      this.angularVelocity = 0;
      this.throttle = options.throttle ?? 0;
      this.isDebris = !!options.debris;
      this.stages = this.isDebris ? [] : Flatspace.stagesOf(this.parts);
      this.stageIndex = 0;
      this.stabilityAssist = !this.isDebris;
      this.stabilityAssistMode = 'stability';
      this.stabilityAssistTarget = null;
      this.rotation = 0; // player rotation input, -1..1
      this.landed = null; // {longitude, relativeRotation} when resting on the ground
      this.splashed = false;
      this.dead = false;
      this.thrustNow = 0;
      this.thrustLocal = { x: 0, y: 0 };
      this.thrustTorque = 0;
      this.gimbalAuthority = 0;
      this.thrustAccel = { x: 0, y: 0 };
      this.heat = 0; // 0..1 reentry glow
      this.dynamicPressure = 0; // dynamic pressure (Pa)
      this.age = 0;
      this.stats = { maxAltitude: 0, maxSpeed: 0, launched: false };
      this.relayout();
    }

    relayout() {
      this.layout = Flatspace.massLayout(this.parts);
      this.mass = this.layout.mass;
      this.dragArea = this.parts.reduce((sum, part) => sum + part.dragArea + chuteArea(part), 0);
      this.torqueWheel = this.parts.reduce((sum, part) => sum + (part.type.torque || 0), 0);
      this.hasCommand = this.parts.some((part) => part.type.command);
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
      return Vector.length(this.position) - this.body.radius;
    }
    // distance from the centre of mass to the lowest / highest point along the rocket axis
    get bottomDistance() {
      return -this.layout.minY;
    }
    get topDistance() {
      return this.layout.maxY;
    }

    // Height of the centre of mass above the ground when resting at an angle from upright.
    restDistance(tilt) {
      if (tilt === 0) {
        return this.bottomDistance;
      }
      if (tilt === Math.PI) {
        return this.topDistance;
      }
      const worldUp = { x: Math.sin(tilt), y: Math.cos(tilt) }; // world "up" in the craft frame
      let depth = 0;
      for (const part of this.parts) {
        for (const hullPoint of part.centredHull) {
          depth = Math.max(depth, -Vector.dot(hullPoint, worldUp));
        }
      }
      return depth;
    }

    // Resting on the ground, does the engines' turning effect beat what the weight can hold?
    // The craft tips over the edge of its base on the side it is turning towards.
    tipsOver(thrustVector, mass, gravity) {
      const torque = this.thrustTorque;
      if (Math.abs(torque) < 1) {
        return false;
      }
      const tilt = this.landed.relativeRotation;
      const worldUp = { x: Math.sin(tilt), y: Math.cos(tilt) };
      const right = { x: Math.cos(tilt), y: -Math.sin(tilt) };
      let lowest = Infinity;
      for (const part of this.parts) {
        for (const hullPoint of part.centredHull) {
          lowest = Math.min(lowest, Vector.dot(hullPoint, worldUp));
        }
      }
      const side = torque < 0 ? 1 : -1; // turning clockwise lowers the right-hand side
      let edge = 0;
      for (const part of this.parts) {
        for (const hullPoint of part.centredHull) {
          if (Vector.dot(hullPoint, worldUp) < lowest + 0.25) {
            edge = Math.max(edge, side * Vector.dot(hullPoint, right));
          }
        }
      }
      const normalForce = Math.max(
        0,
        mass * gravity - Vector.dot(thrustVector, Vector.normalise(this.position)),
      );
      return Math.abs(torque) > normalForce * edge;
    }

    // A craft-frame vector (relative to the centre of mass) in world coordinates.
    toWorld(local) {
      const nose = this.nose;
      return { x: nose.y * local.x + nose.x * local.y, y: -nose.x * local.x + nose.y * local.y };
    }

    placeOnPad(time) {
      this.landed = { longitude: this.body.launchPad.longitude, relativeRotation: 0 };
      this.syncLanded(time);
    }

    syncLanded(time) {
      const body = this.body;
      const landing = this.landed;
      const radialAngle = landing.longitude + Flatspace.bodyRotation(body, time);
      const ground = Flatspace.surfaceHeight(body, landing.longitude);
      const rest = this.restDistance(landing.relativeRotation);
      this.position = Vector.fromAngle(radialAngle, body.radius + ground + rest + 0.02);
      this.velocity = Flatspace.airVelocity(body, this.position);
      this.angle = radialAngle + landing.relativeRotation;
      this.angularVelocity = body.angularVelocity;
    }

    // ---- Staging ----
    stage(game) {
      if (this.stageIndex >= this.stages.length) {
        return null;
      }
      const stage = this.stages[this.stageIndex++];
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
      const partType = part.type;
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
      const droppedSet = new Set(Flatspace.subtree(this.parts, decoupler));
      let keep = this.parts.filter((part) => !droppedSet.has(part));
      let drop = [...droppedSet];
      const hasCommandPart = (list) => list.some((part) => part.type.command);
      if (!hasCommandPart(keep) && hasCommandPart(drop)) {
        [keep, drop] = [drop, keep];
      }
      if (!keep.length || !drop.length) {
        return null;
      }

      const oldCentreOfMass = this.layout.centreOfMass;
      const spinRate = this.angularVelocity;
      const oldPosition = this.position;
      const oldVelocity = this.velocity;
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
      const keptShift = this.toWorld(Vector.subtract(this.layout.centreOfMass, oldCentreOfMass));
      this.position = Vector.add(oldPosition, keptShift);
      this.velocity = Vector.add(oldVelocity, spin(keptShift));

      const debrisVessel = new Vessel('Debris', drop, this.body, { debris: true });
      const droppedShift = this.toWorld(Vector.subtract(debrisVessel.layout.centreOfMass, oldCentreOfMass));
      debrisVessel.position = Vector.add(oldPosition, droppedShift);
      debrisVessel.velocity = Vector.add(oldVelocity, spin(droppedShift));
      debrisVessel.angle = this.angle;
      debrisVessel.angularVelocity = spinRate;
      debrisVessel.landed = null;

      let apart = Vector.subtract(droppedShift, keptShift);
      apart = Vector.length(apart) > 1e-6 ? Vector.normalise(apart) : Vector.scale(this.nose, -1);
      debrisVessel.velocity = Vector.add(debrisVessel.velocity, Vector.scale(apart, 1.0));
      this.velocity = Vector.subtract(this.velocity, Vector.scale(apart, 0.4));
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
        torque += Vector.cross(engine.centreOffset, forceVector);
        total += force;
        if (engine.type.engine.gimbal) {
          gimbal +=
            force *
            Math.sin((engine.type.engine.gimbal * (engine.gimbal ?? 1) * Math.PI) / 180) *
            Math.abs(Vector.dot(engine.centreOffset, engine.axis));
        }
        this.nozzles.push({ part: engine, power, solid });
        flame = true;
      };
      for (const fuelGroup of Flatspace.flowGroups(this.parts)) {
        const liquidEngines = fuelGroup.filter(
          (groupPart) => groupPart.lit && groupPart.type.engine && !groupPart.type.engine.solid,
        );
        const tanks = fuelGroup.filter((groupPart) => groupPart.type.fuel);
        const fuel = tanks.reduce((sum, tank) => sum + tank.fuel, 0);
        if (liquidEngines.length) {
          anyLit = true;
        }
        if (liquidEngines.length && fuel > 0 && this.throttle > 0) {
          let massFlowRate = 0;
          const each = liquidEngines.map((engine) => {
            const thrust = Flatspace.partThrust(engine, pressure, this.throttle);
            massFlowRate += thrust.massFlowRate;
            return thrust.force;
          });
          let fraction = 1;
          if (timeStep > 0) {
            const want = massFlowRate * timeStep;
            fraction = Math.min(1, fuel / want);
            const used = want * fraction;
            for (const tank of tanks) {
              tank.fuel = Math.max(0, tank.fuel - used * (tank.fuel / fuel));
            }
          }
          liquidEngines.forEach((engine, index) =>
            push(engine, each[index] * fraction, this.throttle * fraction, false),
          );
        }
        for (const groupPart of fuelGroup) {
          if (groupPart.lit && groupPart.type.engine && groupPart.type.engine.solid && groupPart.solid > 0) {
            const thrust = Flatspace.partThrust(groupPart, pressure, 1);
            let fraction = 1;
            if (timeStep > 0) {
              fraction = Math.min(1, groupPart.solid / (thrust.massFlowRate * timeStep));
              groupPart.solid = Math.max(0, groupPart.solid - thrust.massFlowRate * timeStep * fraction);
            }
            push(groupPart, thrust.force * fraction, fraction, true);
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
      for (const fuelGroup of Flatspace.flowGroups(this.parts)) {
        const fuel = fuelGroup.reduce((sum, groupPart) => sum + groupPart.fuel, 0);
        for (const groupPart of fuelGroup) {
          if (
            groupPart.lit &&
            groupPart.type.engine &&
            (groupPart.type.engine.solid ? groupPart.solid > 0 : fuel > 0)
          ) {
            litEngines.push(groupPart);
          }
        }
      }
      if (litEngines.length) {
        return litEngines;
      }
      const next = this.stages.slice(this.stageIndex).find((stage) => stage.ignite);
      return next ? next.engines.filter((engine) => this.parts.includes(engine)) : [];
    }

    // Fuel left and capacity in the groups feeding the active engines.
    stageFuel() {
      const engines = new Set(this.activeEngines());
      let now = 0;
      let max = 0;
      for (const fuelGroup of Flatspace.flowGroups(this.parts)) {
        if (!fuelGroup.some((groupPart) => engines.has(groupPart))) {
          continue;
        }
        for (const groupPart of fuelGroup) {
          now += groupPart.fuel + (engines.has(groupPart) ? groupPart.solid : 0);
          max += (groupPart.fuelCapacity || 0) + (engines.has(groupPart) ? groupPart.type.solid || 0 : 0);
        }
      }
      return { now, max };
    }

    stabilityAssistTargetAngle(game) {
      const mode = this.stabilityAssistMode;
      if (mode === 'stability') {
        return this.stabilityAssistTarget;
      }
      const position = this.position;
      const nearSurface = this.altitude < (this.body.atmosphere ? this.body.atmosphere.height * 0.5 : 10000);
      const velocity = nearSurface
        ? Vector.subtract(this.velocity, Flatspace.airVelocity(this.body, position))
        : this.velocity;
      if (Vector.length(velocity) < 0.5 && (mode === 'prograde' || mode === 'retrograde')) {
        return this.stabilityAssistTarget;
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
          if (node && node.remaining && Vector.length(node.remaining) > 0.01) {
            return Vector.angle(node.remaining);
          }
          return this.stabilityAssistTarget;
        }
      }
      return this.stabilityAssistTarget;
    }

    // ---- Aerodynamics ----
    // The air's force on every part (Flatspace.partAerodynamics: drag along the flow, and a sideways push
    // that fins feel most), each acting at the part's centre, so fins at the tail turn the
    // nose into the airflow. Returns the total force (world) and the turning effect about
    // the centre of mass.
    aerodynamics(vAir, dynamicPressure, angle) {
      const airSpeed = Vector.length(vAir);
      if (dynamicPressure <= 0 || airSpeed < 1e-6) {
        return { force: { x: 0, y: 0 }, torque: 0 };
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
          Vector.scale(Flatspace.partAerodynamics(part, localAirDirection, chuteArea(part)), dynamicPressure),
        );
        force = Vector.add(force, partForce);
        torque += Vector.cross(toWorldFrame(part.centreOffset), partForce);
      }
      return { force, torque };
    }

    // ---- Physics step ----
    step(timeStep, time, game) {
      if (this.dead) {
        return;
      }
      this.age += timeStep;
      const body = this.body;
      const pressure = Flatspace.pressure(body, this.altitude);
      const airDensity = Flatspace.density(body, this.altitude);

      // Parachute state machine
      const heightAboveGround =
        this.altitude -
        Flatspace.surfaceHeight(body, Flatspace.longitudeAt(body, Vector.angle(this.position), time));
      for (const part of this.parts) {
        if (
          part.chute === 'armed' &&
          pressure > 0.04 &&
          Vector.length(Vector.subtract(this.velocity, Flatspace.airVelocity(body, this.position))) < 300
        ) {
          part.chute = 'halfOpen';
          part.deploy = 0;
        }
        if (part.chute === 'halfOpen' && heightAboveGround < (part.chuteAltitude ?? 1000)) {
          part.chute = 'full';
          part.deploy = 0;
        }
        if ((part.chute === 'halfOpen' || part.chute === 'full') && part.deploy < 1) {
          part.deploy = Math.min(1, part.deploy + timeStep * 0.4);
        }
      }

      // Engines
      const thrustMagnitude = this.runEngines(timeStep, pressure);
      this.thrustNow = thrustMagnitude;
      this.relayout();
      const mass = this.mass;
      const thrustVector = this.toWorld(this.thrustLocal);

      if (this.landed) {
        // Resting on the ground: lift off only if thrust beats weight.
        const worldUp = Vector.normalise(this.position);
        const gravity = body.gravityParameter / Vector.dot(this.position, this.position);
        if (Vector.dot(thrustVector, worldUp) > mass * gravity * 1.0001) {
          this.landed = null;
          this.splashed = false;
          this.position = Vector.add(this.position, Vector.scale(worldUp, 0.05));
        } else if (this.tipsOver(thrustVector, mass, gravity)) {
          // engines turning the craft harder than its weight holds it: it tips and pivots on the ground
          this.landed = null;
          this.splashed = false;
          this.rolling = true;
          this.position = Vector.add(this.position, Vector.scale(worldUp, 0.01));
        } else {
          this.syncLanded(time);
          this.thrustAccel = { x: 0, y: 0 };
          return;
        }
      }

      // Forces
      const distanceFromCentre = Vector.length(this.position);
      const gravityAcceleration = Vector.scale(
        this.position,
        -body.gravityParameter / (distanceFromCentre * distanceFromCentre * distanceFromCentre),
      );
      const vAir = Vector.subtract(this.velocity, Flatspace.airVelocity(body, this.position));
      const airSpeed = Vector.length(vAir);
      const dynamicPressure = 0.5 * airDensity * airSpeed * airSpeed;
      this.dynamicPressure = dynamicPressure;
      const drag = this.aerodynamics(vAir, dynamicPressure, this.angle);
      this.thrustAccel = Vector.scale(thrustVector, 1 / mass);
      const acceleration = Vector.add(
        gravityAcceleration,
        Vector.scale(Vector.add(thrustVector, drag.force), 1 / mass),
      );
      this.velocity = Vector.add(this.velocity, Vector.scale(acceleration, timeStep));
      this.position = Vector.add(this.position, Vector.scale(this.velocity, timeStep));
      this.gForce =
        Vector.length(Vector.subtract(acceleration, gravityAcceleration)) / Flatspace.STANDARD_GRAVITY;
      this.heat = Flatspace.clamp((airDensity * airSpeed * airSpeed * airSpeed) / 6e7 - 0.1, 0, 1);

      // Torques (sub-stepped for stability with strong aero torques)
      const inertia = this.layout.momentOfInertia;
      const maxTorque = this.hasCommand ? this.torqueWheel + this.gimbalAuthority : 0;
      const craftLength = this.layout.height;
      const substeps = 4;
      const substep = timeStep / substeps;
      for (let substepIndex = 0; substepIndex < substeps; substepIndex++) {
        let torque = this.thrustTorque; // engines off the centre line turn the craft
        if (dynamicPressure > 0) {
          torque += this.aerodynamics(vAir, dynamicPressure, this.angle).torque;
          torque -=
            (0.6 * dynamicPressure * this.dragArea * craftLength * craftLength * this.angularVelocity) /
            Math.max(airSpeed, 5); // damping
        }
        if (!this.isDebris && maxTorque > 0) {
          if (this.rotation !== 0) {
            torque += this.rotation * maxTorque;
            this.stabilityAssistTarget = this.angle;
          } else if (this.stabilityAssist) {
            let target = this.stabilityAssistTargetAngle(game);
            if (target == null) {
              this.stabilityAssistTarget = this.angle;
              target = this.angle;
            }
            const angleError = Flatspace.wrapAngle(target - this.angle);
            const alphaMax = maxTorque / inertia;
            const maxTurnRate = Math.min(1.2, Math.sqrt(2 * alphaMax * Math.abs(angleError)) * 0.8);
            const targetSpin = Flatspace.clamp(angleError * 2.5, -maxTurnRate, maxTurnRate);
            torque += Flatspace.clamp(
              inertia * (targetSpin - this.angularVelocity) * 10,
              -maxTorque,
              maxTorque,
            );
          }
        }
        this.angularVelocity += (torque / inertia) * substep;
        this.angularVelocity = Flatspace.clamp(this.angularVelocity, -12, 12);
        this.angle += this.angularVelocity * substep;
      }
      this.angle = Flatspace.wrapAngle(this.angle);

      // Stats
      const altitude = this.altitude;
      if (body === Flatspace.root) {
        this.stats.maxAltitude = Math.max(this.stats.maxAltitude, altitude);
      }
      this.stats.maxSpeed = Math.max(this.stats.maxSpeed, Vector.length(this.velocity));

      this.checkGround(time, game);
      this.checkSphereOfInfluence(time, game);
    }

    // Test every corner of every part against the ground.
    checkGround(time, game) {
      const body = this.body;
      const reach = Math.max(this.layout.height, this.layout.width);
      const farAbove = this.altitude > body.terrain.amplitude * 2.5 + reach + 50; // far above any ground
      let hit = null;
      const touching = [];
      if (!farAbove) {
        for (const part of this.parts) {
          for (const hullPoint of part.centredHull) {
            const point = Vector.add(this.position, this.toWorld(hullPoint));
            const longitude = Flatspace.longitudeAt(body, Vector.angle(point), time);
            const clear = Vector.length(point) - body.radius - Flatspace.surfaceHeight(body, longitude);
            if (clear < 0) {
              touching.push({ hullPoint, point, part, clear });
              if (!hit || clear < hit.clear) {
                hit = { clear, part, longitude, bottom: hullPoint.y < 0 };
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
      if (this.rolling || Math.abs(this.angularVelocity - body.angularVelocity) > 0.5) {
        this.groundContact(time, game, hit, touching);
        return;
      }
      const speed = Vector.length(Vector.subtract(this.velocity, Flatspace.airVelocity(body, this.position)));
      const worldUp = Vector.normalise(this.position);
      const tilt = Math.acos(Flatspace.clamp(Vector.dot(this.nose, worldUp), -1, 1));
      const water = body.ocean && Flatspace.terrainHeight(body, hit.longitude) < 0;
      const crashTolerance = hit.part.type.crash;
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
      const inertia = this.layout.momentOfInertia;
      const worldUp = Vector.normalise(this.position);
      const tangent = { x: -worldUp.y, y: worldUp.x };
      const velocityAtPoint = (offset, point) =>
        Vector.subtract(
          {
            x: this.velocity.x - this.angularVelocity * offset.y,
            y: this.velocity.y + this.angularVelocity * offset.x,
          },
          Flatspace.airVelocity(body, point),
        );
      this.rolling = true;
      this.lastContact = time;
      for (const contact of touching) {
        const offset = this.toWorld(contact.hullPoint);
        if (Vector.length(velocityAtPoint(offset, contact.point)) > contact.part.type.crash) {
          this.explode(game);
          return;
        }
      }
      this.position = Vector.add(this.position, Vector.scale(worldUp, -hit.clear));
      for (let pass = 0; pass < 2; pass++) {
        for (const contact of touching) {
          const offset = this.toWorld(contact.hullPoint);
          const pointVelocity = velocityAtPoint(offset, contact.point);
          const normalSpeed = Vector.dot(pointVelocity, worldUp);
          if (normalSpeed >= 0) {
            continue;
          }
          const normalLever = Vector.cross(offset, worldUp);
          const impulse =
            (-(1 + 0.1) * normalSpeed) / (1 / mass + (normalLever * normalLever) / inertia) / touching.length;
          this.velocity = Vector.add(this.velocity, Vector.scale(worldUp, impulse / mass));
          this.angularVelocity += (normalLever * impulse) / inertia;
          const tangentLever = Vector.cross(offset, tangent);
          const tangentSpeed = Vector.dot(velocityAtPoint(offset, contact.point), tangent);
          const frictionImpulse = Flatspace.clamp(
            -tangentSpeed / (1 / mass + (tangentLever * tangentLever) / inertia),
            -0.8 * impulse,
            0.8 * impulse,
          );
          this.velocity = Vector.add(this.velocity, Vector.scale(tangent, frictionImpulse / mass));
          this.angularVelocity += (tangentLever * frictionImpulse) / inertia;
        }
      }
      // settled: at rest for half a second, and the engines can't turn it any more
      // (a little contact jitter is allowed: only a real movement restarts the clock)
      const speed = Vector.length(Vector.subtract(this.velocity, Flatspace.airVelocity(body, this.position)));
      const spin = Math.abs(this.angularVelocity - body.angularVelocity);
      if (speed > 1 || spin > 0.15) {
        this.stillSince = null;
      } else if (speed < 0.5 && spin < 0.1) {
        this.stillSince = this.stillSince ?? time;
      }
      const still = this.stillSince != null;
      if (still && time - this.stillSince > 0.5 && Math.abs(this.thrustTorque) < 1) {
        const radialAngle = Vector.angle(this.position);
        this.landed = {
          longitude: Flatspace.longitudeAt(body, radialAngle, time),
          relativeRotation: Flatspace.wrapAngle(this.angle - radialAngle),
        };
        this.rolling = false;
        this.stillSince = null;
        this.splashed = !!(body.ocean && Flatspace.terrainHeight(body, hit.longitude) < 0);
        this.angularVelocity = 0;
        this.syncLanded(time);
        if (game && !this.isDebris) {
          game.emit('touchdown', { vessel: this, water: this.splashed });
        }
      }
    }

    setLanded(time, water, game) {
      const body = this.body;
      const radialAngle = Vector.angle(this.position);
      const longitude = Flatspace.longitudeAt(body, radialAngle, time);
      // settle upright or upside-down, whichever is closer
      let tilt = Flatspace.wrapAngle(this.angle - radialAngle);
      tilt = Math.abs(tilt) > Math.PI / 2 ? Math.PI : 0;
      this.landed = { longitude, relativeRotation: tilt };
      this.splashed = water;
      this.angularVelocity = 0;
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

    checkSphereOfInfluence(time, game) {
      const body = this.body;
      if (body.parent && Vector.length(this.position) > body.sphereOfInfluence) {
        this.position = Vector.add(this.position, Flatspace.bodyPosition(body, time));
        this.velocity = Vector.add(this.velocity, Flatspace.bodyVelocity(body, time));
        this.body = body.parent;
        if (game) {
          game.emit('sphere-change', { vessel: this, from: body });
        }
        return;
      }
      for (const moon of body.children) {
        const moonPosition = Flatspace.bodyPosition(moon, time);
        if (
          Math.hypot(this.position.x - moonPosition.x, this.position.y - moonPosition.y) <
          moon.sphereOfInfluence
        ) {
          this.position = Vector.subtract(this.position, moonPosition);
          this.velocity = Vector.subtract(this.velocity, Flatspace.bodyVelocity(moon, time));
          this.body = moon;
          if (game) {
            game.emit('sphere-change', { vessel: this, from: body });
          }
          return;
        }
      }
    }

    // ---- On rails ----
    goOnRails(time) {
      this.rails = Flatspace.orbitFromState(this.position, this.velocity, this.body.gravityParameter, time);
    }
    railsTo(time, game) {
      if (this.landed) {
        this.syncLanded(time);
        return;
      }
      const state = Flatspace.orbitState(this.rails, time);
      this.position = state.position;
      this.velocity = state.velocity;
      const previousBody = this.body;
      this.checkSphereOfInfluence(time, game);
      if (this.body !== previousBody) {
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
      if (body.atmosphere && altitude < body.atmosphere.height) {
        return 'Flying over ' + body.name;
      }
      const orbit = Flatspace.orbitFromState(this.position, this.velocity, body.gravityParameter, 0);
      if (orbit.eccentricity >= 1 || orbit.apoapsis > body.sphereOfInfluence) {
        return 'Escaping ' + body.name;
      }
      const safe = body.radius + (body.atmosphere ? body.atmosphere.height : body.terrain.amplitude * 1.5);
      if (orbit.periapsis > safe) {
        return 'Orbiting ' + body.name;
      }
      return 'Sub-orbital, ' + body.name;
    }
  }

  Flatspace.Vessel = Vessel;
})();
