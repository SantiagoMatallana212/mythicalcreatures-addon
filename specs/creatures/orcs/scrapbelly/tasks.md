# Tareas de implementación de Scrapbelly

Basadas en [spec.md](./spec.md) y [plan.md](./plan.md). T1 completada; T2 implementada y lista para verificar en juego; T3–T7 pendientes. Completar cada tarea y su verificación antes de cerrar sus dependientes.

Mantener `orc.json` en `1.26.30`, sin `in_range_movement_mode`, cambios de manifiestos ni reconciliación preventiva de entidades existentes. Reutilizar componentes nativos y sistemas actuales; no añadir JS, bridges o propiedades de estado sin una limitación demostrada y revisada.

- [x] T1. Preparar el hand cannon y su attachment

- **Objetivo:** disponer de un arma interna equipable y visible, reutilizando los assets existentes.
- **Áreas:** `mythical_BP/items/hand_cannon.json`, `mythical_BP/loot_tables/entities/scrapbelly_gear.json`, equipamiento del grupo `scrapbelly` en `orc.json`, `mythical_RP/attachables/hand_cannon.attachable.json` y binding de `hand_cannon.geo.json`.
- **Dependencias:** ninguna.
- **Hecho:** item interno y attachable comparten identificador; Scrapbelly usa la tabla para equipar mainhand, con drop chance 0 en su componente de equipamiento. El attachable reutiliza geometría/textura del cañón y el binding al slot, sin modificar el modelo base del Orc. Sin `item_texture.json`, icono, categoría de creativo, recetas ni funcionalidad de uso; sin implementar combate, sensores o `cannonball`.
- **Verificación:** validar JSON y la cadena spawn → grupo Scrapbelly → tabla → item → attachable → geometría/textura; invocar `/summon mythicalcreatures:orc ~ ~ ~ spawn_as_scrapbelly` en juego y comprobar cañón en mainhand, attachment en reposo/locomoción, ausencia en creativo y ausencia de drops.
- **Estado:** completada por indicación del usuario; equipamiento y render confirmados en juego, geometría recentrada por la empuñadura y comprobaciones estáticas correctas.

- [ ] T2. Crear el proyectil físico `cannonball`

- **Objetivo:** disponer de `mythicalcreatures:cannonball` con impacto directo y presentación propia.
- **Áreas:** nueva entidad BP `cannonball` con schema estable `1.26.50`, entidad cliente RP y render controller; modelo/textura `cannonball` existentes.
- **Dependencias:** ninguna.
- **Hecho:** proyectil sin runtime vanilla, con física explícita, daño directo único, knockback nativo y retirada tras impacto o tiempo de vida; sin hitscan, explosión, fuego ni splash. Configurada regla nativa de knockback cero para Greenskins.
- **Verificación:** validar schema e identificadores contra fuentes oficiales estables; comprobar en juego visibilidad, trayectoria, impacto único y eliminación mediante un lanzamiento de prueba, sin introducir un bridge de producción. El disparo real del Orc se verifica en 3–4.
- **Estado:** BP, client entity y render controller implementados; schemas/referencias comprobados, pendiente playtest. Valores iniciales: daño fijo 8, power 3, gravity 0.03, inaccuracy 0, knockback horizontal 4/vertical 0.1 para enemigos, cero para Greenskins y timeout 5 s. `/summon mythicalcreatures:cannonball ~ ~2 ~` permite comprobar render/timeout; trayectoria e impacto requieren un lanzamiento real con owner para comprobar el friendly fire existente. Shooter y modos de Scrapbelly siguen intactos.
- **Validación estática:** schemas de `bedrock-samples` `v1.26.50.4`; el metadata `Filter Group` tiene un `oneOf` ambiguo para filtros simples. Ambos filtros se validaron contra `Filter Test` y coinciden con Ashgnaw, sin modificar el patrón del proyecto.

- [] T3. Integrar equipamiento y modos nativos excluyentes

- **Objetivo:** sustituir el placeholder de Scrapbelly por su combate ranged/melee dentro del Orc actual.
- **Áreas:** `mythical_BP/entities/orc.json`; referencias Ashgnaw y bash de Shieldlug.
- **Dependencias:** 1 y 2.
- **Hecho:** `scrapbelly` conserva identidad, equipo y detector; ranged contiene shooter con `mythicalcreatures:cannonball` y `ranged_attack`; melee contiene attack, delayed_attack y knockback, incluido cero para aliados. Spawn activa identidad+ranged; cada transición retira el modo anterior antes de añadir el siguiente, con guardas de variante e histéresis. Pérdida de visión/target devuelve ranged; targeting y liderazgo comunes se conservan.
- **Verificación:** validar JSON, referencias y eventos; probar spawn, entrada/salida melee y pérdida de target/visión. Confirmar un solo modo ofensivo, ausencia de oscilación y bash con preparación e impacto nativos.

- [] T4. Validar y ajustar el ranged legacy

- **Objetivo:** conseguir disparos individuales precisos y lentos con carga nativa y una posición de tiro útil.
- **Áreas:** shooter y ranged de Scrapbelly en `orc.json`, física/origen del proyectil y alineación con el attachment.
- **Dependencias:** 3.
- **Hecho:** carga, lanzamiento y cadencia funcionan sin reinstalar goals por disparo; velocidad, precisión y ritmo se aproximan a la spec mediante playtest. El origen físico resulta coherente con el cañón y se han identificado las señales nativas para presentación.
- **Verificación:** contrastar campos legacy con documentación oficial; probar blancos móviles, desnivel, obstáculos, movimiento a distancia y paso a melee durante la carga. Si el movimiento legacy o la carga no cumplen, registrar la limitación y dejar pendiente lo afectado antes de proponer una migración.

- [] T5. Integrar preparación, disparo, recoil/recovery y bash visuales

- **Objetivo:** mostrar el ciclo real de combate sin controlar daño o lanzamiento desde el RP.
- **Áreas:** `mythical_RP/entity/orc.entity.json`, animaciones/controller Scrapbelly y pose del hand cannon.
- **Dependencias:** 4.
- **Hecho:** presentación exclusiva de la variante, sincronizada con preparación real, disparo, recoil/recovery y delayed attack; locomoción conservada y sin superposición del swing genérico. Se usan señales nativas (`swing`/`variable.attack_time`, `query.is_delayed_attacking`), sin estado adicional.
- **Verificación:** validar referencias RP y observar ciclos completos e interrupciones por cambio de modo/target; comprobar correspondencia entre preparación, lanzamiento e impacto melee. Si las señales no bastan, registrar la limitación y dejar pendiente la sincronización antes de añadir scripting.

- [] T6. Verificar friendly fire con el mecanismo existente

- **Objetivo:** proteger a Greenskins tanto del daño como del empuje del disparo y del bash.
- **Áreas:** configuración nativa de cannonball/melee; `greenskin/friendly_fire.js` como mecanismo reutilizado, sin cambios preventivos.
- **Dependencias:** 2 y 3; puede cerrarse sin la presentación final.
- **Hecho:** owner y marcado existentes identifican el proyectil; aliados no reciben daño ni knockback y una intercepción retira la bola. Los enemigos siguen recibiendo el impacto previsto. Sin nueva infraestructura salvo prueba concreta de insuficiencia.
- **Verificación:** probar aliados interceptores, shooter/monturas, owner muerto o descargado, proyectiles cargados de nuevo y varios Scrapbellies; comprobar daño y empuje por separado. Ante un fallo, aislar su causa antes de cambiar el mecanismo compartido.

- [] T7. Cerrar persistencia, regresiones y aceptación en juego

- **Objetivo:** confirmar integración completa y continuidad del comportamiento tras carga/recarga.
- **Áreas:** conjunto BP/RP Scrapbelly, órdenes de liderazgo y regresiones pertinentes de otras variantes.
- **Dependencias:** 1–6.
- **Hecho:** entidades creadas con la implementación conservan equipo y modo tras descarga/recarga, reinicio y `/reload`; no duplican ataques ni pierden órdenes. Cumplen los criterios de la spec y se distinguen de Ashgnaw, Bombchucker y ranged ligeros, sin migrar Scrapbellies antiguos.
- **Verificación:** comprobaciones estáticas dirigidas y regresiones existentes pertinentes, interpretando expectativas obsoletas; playtest en 26.50/26.52, en ambos modos y con gráficos estándar/Vibrant Visuals. Registrar resultados y limitaciones reales; no declarar gameplay verificado solo por tests automáticos.
