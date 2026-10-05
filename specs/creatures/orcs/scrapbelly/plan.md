# Plan de implementación de Scrapbelly

## Arquitectura de combate

Implementar Scrapbelly dentro de `mythicalcreatures:orc`, conservando `orc_variant`, targeting, persistencia y eventos comunes. Mantener **`orc.json` en formato 1.26.30** y seguir la separación nativa de modos usada por Ashgnaw, con el bash de Shieldlug como referencia.

| Grupo | Responsabilidad |
| --- | --- |
| `scrapbelly` | Identidad, familias, equipamiento del hand cannon y detector nativo de distancia. |
| `scrapbelly_ranged_mode` | `minecraft:shooter` y `minecraft:behavior.ranged_attack`. |
| `scrapbelly_melee_mode` | `minecraft:attack`, `minecraft:behavior.delayed_attack` y `minecraft:apply_knockback_rules`. |

- `spawn_as_scrapbelly` limpia modos Scrapbelly residuales y añade identidad más ranged.
- Al entrar en distancia melee, el evento **retira ranged antes de añadir melee**; al salir, **retira melee antes de añadir ranged**.
- Usar histéresis alrededor del umbral cercano de la spec para evitar oscilación, siguiendo el sensor de Ashgnaw. La pérdida de visión/target devuelve al modo ranged de espera.
- Restringir eventos a `orc_variant == scrapbelly`. No retirar grupos de otras variantes, modificar targeting ni sobrescribir estados de liderazgo.
- Conservar modos y equipo mediante la persistencia nativa.

No añadir módulo JS de Scrapbelly, bridges de proyectiles, timers scripted ni propiedades nuevas de modo/estado. No hay una limitación demostrada que justifique esos sistemas.

## Integración de arma y proyectil

**Hand cannon.** Añadir item interno BP y tabla de equipamiento específica; conectarlos a un attachable RP con el mismo identificador. Equipar mainhand, sin acceso normal desde inventario creativo, recetas, uso de jugador ni drops. El daño melee pertenece al modo, no al item.

Reutilizar geometría y textura actuales del cañón. Su geometría necesita binding al slot de mano, siguiendo el attachable Shieldlug y el `rightItem` ya existente del Orc. Adaptar solo esa geometría al formato que admite binding; no modificar el modelo base del Orc ni añadir recursos PBR.

**Cannonball.** Crear `mythicalcreatures:cannonball` como proyectil físico custom, lanzado por el shooter nativo. Sustituye la referencia actual a `mythicalcreatures:cannonball_projectile`, cuya entidad no existe. Usar `cannonball` de forma consistente para el proyectil y sus assets; conservar `geometry.cannonball` y sus archivos, sin renombrarlos ni crear duplicados.

Definir el proyectil nuevo con schema estable 1.26.50, sin runtime vanilla. Mantener daño directo, velocidad alta, precisión y knockback de la spec; explicitar física e impacto único y eliminar la bola tras contacto o tiempo de vida. No añadir explosión, fuego, splash ni daño hitscan. El knockback se configura nativamente en el proyectil, como demuestra el sample estable de Egg.

Reutilizar el mecanismo de proyectiles de `greenskin/friendly_fire.js`, que reconoce owner y aplica su marcado existente al spawn/load. No añadir infraestructura de friendly fire salvo que una prueba demuestre que hace falta. Mantener reglas nativas de knockback cero para Greenskins tanto en cannonball como en bash: cancelar daño no demuestra ausencia de empuje. Verificar que un aliado que intercepta la bola queda protegido y termina ese proyectil. No añadir la familia Greenskin a la bola ni cambiar el sistema compartido preventivamente.

## Ranged y presentación

Usar el ranged legacy compatible con 1.26.30; lanzamiento, adquisición del objetivo y cadencia pertenecen al goal nativo. Evaluar su carga de un único disparo para conseguir preparación visible y ritmo lento, sin retirar/reinstalar ranged en cada tiro. El bash usa `delayed_attack` para separar preparación e impacto, sin daño scripted.

**No usar `in_range_movement_mode` ahora.** Requiere formato 1.26.50; elevar el Orc obligaría a migrar también los goals ranged de Ashgnaw y Hexmaw. Probar primero el movimiento legacy. Si no permite mantener una posición de tiro útil, documentar esa limitación y tratar la migración por separado.

Conectar animaciones/controller RP exclusivos de Scrapbelly: aim/preparación, disparo, recoil/recovery y cannon bash. Usar señales nativas disponibles; `swing` y `variable.attack_time` para el disparo, `query.is_delayed_attacking` para el bash. Las transiciones temporales del controller visual no lanzan proyectiles ni controlan daño/cooldown.

La preparación debe acompañar al ataque cargado real; mostrar pose de aim con target no basta para certificarla. Verificar la sincronización disponible antes de considerarla resuelta. Si las señales vanilla no permiten un telegraph o recoil fiable, registrar la limitación concreta y revisarla antes de proponer estado adicional o scripting.

Conservar locomoción existente y evitar superponer swing genérico y bash/recoil propios. Ajustar attachment y origen físico del proyectil conjuntamente: un locator cliente del cañón no proporciona automáticamente el origen de lanzamiento al BP.

## Archivos y sistemas afectados

| Área | Integración prevista |
| --- | --- |
| Orc BP | `mythical_BP/entities/orc.json`: identidad/equipo, sensor, modos y eventos nativos. |
| Arma | Item `hand_cannon`, tabla `scrapbelly_gear`, attachable y pose de agarre; binding en la geometría existente y entrada del icono interno. |
| Proyectil | Entidad BP `cannonball`, entidad cliente RP y render controller; reutilizar modelo/textura `cannonball`. |
| Presentación | `mythical_RP/entity/orc.entity.json`, animaciones y controller visual Scrapbelly. |
| Verificación | Comprobaciones dirigidas de eventos/modos e integración de assets, además de playtest. |

Sin cambios de manifiestos, scripts, otras variantes o sistemas compartidos. No implementar todavía ni completar `tasks.md`; tiempos, offsets y potencias concretas se ajustarán durante implementación/playtest.

## Verificación

- Validar JSON y referencias según el formato de cada archivo; comprobar guardas de variante y exclusión ranged/melee tras spawn y cada transición.
- Probar attachment, orientación/origen de disparo y bola visible contra blancos móviles, desnivel y obstáculos; daño directo único y ausencia de efectos de área.
- Comprobar preparación antes del shot, cadencia lenta, recoil/recovery y bash cercano sin ataques simultáneos ni oscilación de modos.
- Verificar cero daño **y** knockback aliado, shooter/monturas, propietario muerto o descargado y varios Scrapbellies.
- Probar entidades creadas con la implementación, descarga/recarga, reinicio y `/reload` en ambos modos; conservar equipo, persistencia y órdenes de liderazgo sin duplicar ataques.
- Ejecutar regresiones pertinentes de liderazgo/Ashgnaw y playtest en 26.50/26.52 con gráficos estándar y Vibrant Visuals. Las expectativas ya obsoletas no justifican cambiar gameplay validado.
- Registrar problemas de movimiento legacy, sincronización visual o física como limitaciones pendientes; los tests estáticos no certifican la spec en juego.

Referencias: [spec local](./spec.md), patrones actuales Ashgnaw/Shieldlug y [ranged_attack oficial](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/entitygoals/minecraftbehavior_ranged_attack?view=minecraft-bedrock-stable). Para el proyectil: [sample Egg estable](https://github.com/Mojang/bedrock-samples/blob/v1.26.50.4/behavior_pack/entities/egg.json).
