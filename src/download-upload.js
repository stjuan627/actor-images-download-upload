const Apify = require('apify');
const rp = require('request-fixed-tunnel-agent');

const { PROXY_URL } = require('./constants');
const { checkIfImage } = require('./utils');

const deduplicateErrors = (errors) => {
    return errors.reduce((newErrors, error) => {
        const maybeFoundDup = newErrors.find((er) => er.when === error.when && er.message === error.message);
        if (maybeFoundDup) {
            return newErrors;
        }
        return newErrors.concat(error);
    }, []);
};

const upload = async (key, buffer, uploadOptions) => {
    const errors = [];
    if (uploadOptions.uploadTo === 'key-value-store') {
        await Apify.setValue(key, buffer, { contentType: 'image/jpeg' })
            .catch((e) => {
                errors.push(e.message);
            });
    }
    if (uploadOptions.uploadTo === 's3') {
        await uploadOptions.s3Client.putObject({
            Key: key,
            Body: buffer,
        }).promise().catch((e) => {
            errors.push(e.message);
        });
    }
    if (errors.length > 0) {
        return {
            imageUploaded: false,
            errors,
        };
    }
    return {
        imageUploaded: true,
        errors,
    };
};

const download = async (url, imageCheck) => {
    const normalOptions = {
        url,
        encoding: null,
        timeout: 25000,
        resolveWithFullResponse: true,
    };
    const proxyOptions = {
        ...normalOptions,
        proxy: PROXY_URL,
    };
    let errorsCount = 0;
    const errors = [];
    let imageDownloaded = false;
    let response;

    const handleError = (e) => {
        errors.push(`${e.message}`);
    };

    const sendRequest = async (options) => {
        return Promise.race([
            rp(options),
            new Promise((resolve) => setTimeout(resolve, 30000)),
        ]).catch(handleError);
    };

    let timeDownloading = 0;
    let timeProcessing = 0;

    while (!imageDownloaded && errorsCount < imageCheck.maxRetries) {
        const startDownloading = Date.now();
        if (errorsCount > 0) {
            response = await sendRequest(proxyOptions);
        } else {
            response = await sendRequest(normalOptions);
        }
        timeDownloading += Date.now() - startDownloading;

        const startProcessing = Date.now();
        const { isImage, error, retry } = await checkIfImage(response, imageCheck);
        timeProcessing += Date.now() - startProcessing;

        if (!isImage) {
            errorsCount++;
            errors.push(error);
        } else {
            imageDownloaded = true;
        }

        if (!retry) break;
    }
    return {
        response,
        errors,
        imageDownloaded,
        timeDownloading,
        timeProcessing,
    };
};

module.exports.downloadUpload = async (url, key, uploadOptions, imageCheck) => {
    const errors = [];
    const time = {
        downloading: 0,
        processing: 0,
        uploading: 0,
    };
    let imageUploaded = false;

    if (!url.includes('http://') && !url.includes('https://')) {
        return {
            imageUploaded,
            errors: [{ when: 'before-download', error: 'url does not contain http or https' }],
            time,
        };
    }

    const {
        response: buffer,
        errors: downloadErrors,
        imageDownloaded,
        timeDownloading,
        timeProcessing,
    } = await download(url, imageCheck);

    time.downloading = timeDownloading;
    time.processing = timeProcessing;

    if (imageDownloaded) {
        const startUploading = Date.now();
        const uploadResult = await upload(key, buffer, uploadOptions);
        time.uploading += (Date.now() - startUploading);

        ({ imageUploaded } = uploadResult);
        uploadResult.errors.forEach((error) => {
            errors.push({ when: 'upload', message: error });
        });
    }
    downloadErrors.forEach((error) => {
        errors.push({ when: 'download', message: error });
    });
    return {
        imageUploaded,
        errors: deduplicateErrors(errors),
        time,
    };
};
