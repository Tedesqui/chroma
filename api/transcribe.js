// /api/transcribe.js
require('dotenv').config();
const aws = require('aws-sdk');
const formidable = require('formidable');
const fs = require('fs');
const https = require('https');

// Configuração da AWS (lê as variáveis de ambiente da Vercel)
aws.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
});

const s3 = new aws.S3();
const transcribeService = new aws.TranscribeService();

// Desabilitamos o parser padrão da Vercel para lidar com arquivos
export const config = {
    api: {
        bodyParser: false,
    },
};

// Função de polling (igual à anterior)
const pollTranscriptionJob = (jobName) => {
    return new Promise((resolve, reject) => {
        const interval = setInterval(async () => {
            try {
                const data = await transcribeService.getTranscriptionJob({ TranscriptionJobName: jobName }).promise();
                const status = data.TranscriptionJob.TranscriptionJobStatus;
                if (status === 'COMPLETED' || status === 'FAILED') {
                    clearInterval(interval);
                    if (status === 'COMPLETED') resolve(data.TranscriptionJob);
                    else reject(new Error(`Transcrição falhou: ${data.TranscriptionJob.FailureReason}`));
                }
            } catch (error) {
                clearInterval(interval);
                reject(error);
            }
        }, 4000); // Verifica a cada 4 segundos
    });
};

// A função principal que a Vercel executará
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const form = formidable({});
        const [fields, files] = await form.parse(req);

        const audioFile = files.audio[0];
        if (!audioFile) {
            return res.status(400).json({ error: 'Nenhum arquivo de áudio enviado.' });
        }

        const audioBuffer = fs.readFileSync(audioFile.filepath);
        const s3BucketName = process.env.S3_BUCKET_NAME;
        const s3Key = `audio-uploads/${Date.now()}-${audioFile.originalFilename}`;
        const jobName = `transcription-job-${Date.now()}`;

        // 1. Upload para o S3
        await s3.upload({ Bucket: s3BucketName, Key: s3Key, Body: audioBuffer }).promise();

        // 2. Iniciar job do Transcribe
        await transcribeService.startTranscriptionJob({
            TranscriptionJobName: jobName,
            LanguageCode: 'pt-BR',
            Media: { MediaFileUri: `s3://${s3BucketName}/${s3Key}` }
        }).promise();

        // 3. Aguardar finalização
        const completedJob = await pollTranscriptionJob(jobName);

        // 4. Obter e retornar a transcrição
        const transcriptFileUri = completedJob.Transcript.TranscriptFileUri;
        https.get(transcriptFileUri, (stream) => {
            let data = '';
            stream.on('data', chunk => data += chunk);
            stream.on('end', () => {
                const result = JSON.parse(data);
                const transcript = result.results.transcripts[0].transcript;
                res.status(200).json({ transcript });
            });
        }).on('error', (err) => { throw err; });

    } catch (error) {
        console.error('Erro na função serverless:', error);
        res.status(500).json({ error: 'Erro ao processar o áudio.' });
    }
}