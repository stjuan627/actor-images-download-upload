const Apify = require('apify');
const rp = require('request-fixed-tunnel-agent');
// const httpRequest = require('@apify/http-request');

const { checkIfImage, convertWebpToPng } = require('./image-check.js');

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
        if (uploadOptions.storeHandle) {
            await uploadOptions.storeHandle.setValue(key, buffer, { contentType: 'image/jpeg' })
                .catch((e) => {
                    errors.push(e.message);
                });
        } else {
            await Apify.setValue(key, buffer, { contentType: 'image/jpeg' })
                .catch((e) => {
                    errors.push(e.message);
                });
        }
    }
    if (uploadOptions.uploadTo === 's3') {
        await uploadOptions.s3Client.putObject({
            Key: key,
            Body: buffer,
        }).promise().catch((e) => {
            errors.push(e.message);
        });
    }

    if (uploadOptions.uploadTo === 'oss') {
        const result = await uploadOptions.ossClient.put(key, buffer).catch(e => {
            errors.push(e.message)
        })
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

const download = async (url, imageCheck, key, downloadOptions) => {
    const { downloadTimeout, maxRetries, proxyConfiguration } = downloadOptions;

    const proxyUrl = proxyConfiguration && proxyConfiguration.useApifyProxy
        ? Apify.getApifyProxyUrl({ groups: proxyConfiguration.apifyProxyGroups })
        : null;
    const normalOptions = {
        strictSSL: false,
        url,
        encoding: null,
        resolveWithFullResponse: true,
    };
    const proxyOptions = {
        ...normalOptions,
        proxy: proxyUrl,
    };
    // Implement once httpRequest gets fixed
    /*
    const httpReqOptions = {
        ignoreSslErrors: true,
        url,
        proxyUrl,
        throwHttpErrors: true,
        encoding: null,
    }
    */
    const errors = [];
    let imageDownloaded = false;
    let response;
    let contentTypeMain;
    let sizesMain;

    const handleError = (e) => {
        errors.push(e.toString());
    };

    const sendRequest = async (options) => {
        return Promise.race([
            rp(options),
            // httpRequest(httpReqOptions),
            new Promise((resolve, reject) => setTimeout(() => reject(new Error('Timeouted')), downloadTimeout)),
        ]).catch(handleError);
    };

    let timeDownloading = 0;
    let timeProcessing = 0;

    while (!imageDownloaded && errors.length <= maxRetries) {
        const startDownloading = Date.now();
        if (proxyUrl) {
            response = await sendRequest(proxyOptions);
        } else {
            response = await sendRequest(normalOptions);
        }
        timeDownloading += Date.now() - startDownloading;
        if (!response) continue; // eslint-disable-line

        const startProcessing = Date.now();
        const { isImage, error, retry, contentType, sizes } = await checkIfImage(response, imageCheck);
        sizesMain = sizes;
        timeProcessing += Date.now() - startProcessing;

        if (!isImage) {
            errors.push(error);
        } else {
            imageDownloaded = true;
            contentTypeMain = contentType;
        }

        if (!retry) break;
    }

    const retryCount = errors.length;

    // converting to other mime
    if (imageDownloaded && contentTypeMain === 'image/webp' && imageCheck.convertWebpToPng) {
        const startProcessing = Date.now();
        try {
            response.body = await convertWebpToPng(response.body, key);
        } catch (e) {
            imageDownloaded = false;
            errors.push(`Error in converting: ${e}`);
        }
        timeProcessing += Date.now() - startProcessing;
    }

    return {
        response,
        errors,
        retryCount,
        imageDownloaded,
        timeDownloading,
        timeProcessing,
        sizes: sizesMain,
        contentType: contentTypeMain,
    };
};

module.exports.downloadUpload = async (url, key, downloadUploadOptions, imageCheck) => {
    const { downloadOptions, uploadOptions } = downloadUploadOptions;
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
        retryCount,
        contentType,
        response,
        errors: downloadErrors,
        imageDownloaded,
        timeDownloading,
        timeProcessing,
        sizes,
    } = await download(url, imageCheck, key, downloadOptions);

    time.downloading = timeDownloading;
    time.processing = timeProcessing;

    if (imageDownloaded) {
        const startUploading = Date.now();
        const uploadResult = await upload(key, response.body, uploadOptions);
        time.uploading += (Date.now() - startUploading);

        ({ imageUploaded } = uploadResult);
        uploadResult.errors.forEach((error) => {
            errors.push({ when: 'upload', message: error });
        });
    }
    downloadErrors.forEach((error) => {
        errors.push({ when: 'download', message: error });
    });
    const infoObject = {
        imageUploaded,
    };
    if (!imageCheck.noInfo) {
        infoObject.errors = deduplicateErrors(errors);
        infoObject.retryCount = retryCount;
        infoObject.contentType = contentType;
        infoObject.sizes = sizes;
        infoObject.time = time;
    }
    return infoObject;
};
