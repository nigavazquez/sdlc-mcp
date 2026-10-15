---
id: skill-code-review-checklist
version: 0.1.1
description: Checklist priorizado para code review.
---

# Skill: Checklist de code review

Pasadas en orden de severidad:

**1. Seguridad (bloquea)**
- [ ] Auth/AuthZ correcto en endpoints nuevos.
- [ ] Validación de input al límite de confianza (no asumir cliente).
- [ ] Sin secretos en logs ni en código.
- [ ] PII enmascarada en logs/respuestas.
- [ ] Inyección (SQL, command, log) imposible por construcción.

**2. Correctness vs RFC (bloquea si diverge sin justificación)**
- [ ] El código implementa lo que el RFC describe.
- [ ] Decisiones que divergen del RFC tienen comentario explicando por qué.

**3. Tests (bloquea)**
- [ ] Tests cubren cada AC de la historia.
- [ ] Happy + error paths para endpoints/funciones públicas.
- [ ] Tests existentes no se rompieron (o el cambio está justificado).

**4. Performance (bloquea si el RFC fija SLA y no se cumple)**
- [ ] Sin N+1 obvios.
- [ ] Sin loops innecesarios en hot path.
- [ ] Allocations razonables.

**5. Observabilidad (bloquea para features nuevos)**
- [ ] Logs estructurados con trace_id y campos relevantes.
- [ ] Métricas para counters/latency de operaciones nuevas.
- [ ] Alertas configuradas si el RFC lo pide.

**6. Maintainability (nit, no bloquea solo)**
- [ ] Naming claro.
- [ ] Complejidad razonable.
- [ ] Sin dead code.
- [ ] Comentarios solo donde el código no es obvio.

Anti-patrones del reviewer:
- "LGTM" sin haber leído el diff.
- Refactor opinions fuera del diff.
- Bloquear sin proponer alternativa.
- Mezclar approve + request changes.
