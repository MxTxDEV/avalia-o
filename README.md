# Prontuário de Avaliação de Desempenho — Grupo ITASUL

Um app estático (um único `index.html`) para o programa **Funcionário do Mês**.

- **Funcionários em cards**: nome, cargo/função, setor, telefone e e-mail.
- **Avaliação mensal por funcionário** com as 8 seções do prontuário:
  identificação, objetivo, critérios (100 pontos), ocorrências, PDI,
  resultado final, indicação para Funcionário do Mês, ciência e acompanhamento.
- Total e classificação calculados automaticamente (Excelente, Muito bom, Bom,
  Precisa melhorar, Desempenho insatisfatório).
- Painel do mês com quem já foi avaliado, a média e os 3 primeiros colocados.
- **Exportação em PDF** (A4) no layout do prontuário, pronta para enviar.
- Backup e restauração em `.json`.

## Onde os dados ficam salvos

| Onde o app está aberto | Armazenamento |
| --- | --- |
| Publicado como Artifact no claude.ai | **Online**: banco de dados compartilhado do artifact, visível a todos com acesso |
| Publicado na Vercel (com `api/data.js`) | **Online**: Vercel Blob privado, protegido por senha de acesso |
| Aberto direto (arquivo local, GitHub Pages etc.) | `localStorage` do navegador. Use *Exportar backup* para guardar uma cópia |

O selo no topo da tela mostra qual armazenamento está em uso.

## Como rodar

Basta abrir `index.html` no navegador, ou publicar a pasta em qualquer
hospedagem estática (por exemplo, GitHub Pages). As bibliotecas de PDF
(html2canvas e jsPDF) e as fontes são carregadas de CDN.

## Vercel

`api/data.js` guarda todos os dados num único arquivo JSON privado no Vercel Blob
(`db/state.json`). Assim cada atualização da tela custa uma leitura só, e várias
pessoas podem usar o app ao mesmo tempo, de aparelhos diferentes:

- a tela se atualiza a cada 15 s enquanto está aberta e na hora em que a pessoa volta para o app;
- duas gravações ao mesmo tempo não se perdem (a gravação confere a versão do arquivo);
- se duas pessoas editam o mesmo registro, quem salva por último escolhe qual versão fica.

O projeto precisa de:

- um Blob store **privado** conectado ao projeto (cria a variável `BLOB_READ_WRITE_TOKEN`);
- a variável `APP_PASSWORD`, com a senha de acesso que a equipe digita ao entrar.

Para trocar a senha, altere `APP_PASSWORD` em *Settings → Environment Variables* e faça um novo deploy.
