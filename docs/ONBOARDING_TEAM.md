# Onboarding de un equipo

> Guía pensada para Fase 4 (deploy prod con OAuth2). En Fase 0 el flujo se simplifica a "el server está corriendo localmente y todos usan la misma API key".

## 1. Registrar el tenant

El admin del equipo entra a `https://sdlc-mcp.<corp>/onboard`, hace login SSO y crea el tenant:

- **Nombre del equipo**: ej. `payments-platform`
- **Task system**: Jira | Linear | GitHub Issues
- **Doc system**: Confluence | Notion | repo

## 2. Conectar credenciales

Por cada sistema externo, el admin pega las credenciales (token o inicia OAuth). El backend las cifra y guarda la referencia.

- Jira Cloud: API token + email
- Linear: personal API key o OAuth user token
- GitHub: GitHub App con permisos `repo` + `issues`

## 3. Asignar roles a usuarios

Tabla `tenant_role_grants`. Un usuario puede tener varios roles (un Tech Lead suele ser también Reviewer).

## 4. Configurar el cliente IDE

Cada developer agrega al `mcp.json` de su IDE:

```json
{
  "mcpServers": {
    "sdlc": {
      "type": "http",
      "url": "https://sdlc-mcp.<corp>/mcp",
      "auth": { "type": "oauth" }
    }
  }
}
```

Primer uso: el cliente abre el browser para login SSO, cachea tokens.

## 5. Primer flow

```
Usuario: @sdlc start_flow project=payments title="Reembolsos automáticos"
Agente: ✅ flow_id = payments-platform:payments:reembolsos-automaticos
Usuario: @sdlc get_role_prompt role=product-manager phase=prd-draft
Agente: <inyecta system prompt + skill + template y empieza a redactar el PRD>
```
